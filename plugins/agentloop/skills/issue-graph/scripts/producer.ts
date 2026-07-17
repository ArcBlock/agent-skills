#!/usr/bin/env bun
/**
 * producer — 定期跑图计算 + 对账 queue label（#1308 Phase 4）。
 *
 * 职责边界（Robert 拍板）：**只算图 + 对账索引，不执行任何实质工作。**
 * producer 挂了 worker 退化回各自跑 graph-scan，无单点。
 *
 * Label 语义（反 label-spam：不给全部"未被 block"的 issue 打标）：
 *   - `agent:ready`   = 图计算发现的**可干事件**：close-kick 目标 ∪ rollup 候选，
 *                       排除 agent:hold。是索引提示不是执行依据——消费方领取后
 *                       必须回 GitHub 重验（仍 open、仍 ready、无 hold、无新人类输入）。
 *   - `agent:blocked` = 有 open blocker（确定性 SKIP 的人可见视图，稀疏）。
 *
 * 生命周期分工：
 *   - producer **加** ready/blocked，并**清理失效**（closed / hold / 变 blocked →
 *     摘 ready；解除 block → 摘 blocked）。
 *   - kick 是瞬态事件：窗口过了不代表事没了，producer **不因"不在本轮计算里"
 *     摘 ready**——那是消费方的活：sweep 处理完一个 agent:ready issue 后摘掉它。
 *
 * 用法：
 *   bun producer.ts [--repo owner/name] [--window-hours 2] [--dry-run]
 */
import { apiPaged, apiRaw, parseArgs, resolveRepo } from "./lib";

const args = parseArgs(Bun.argv.slice(2));
const repo = resolveRepo(args.get("repo") as string | undefined);
const windowHours = Number(args.get("window-hours") ?? 2);
const dryRun = args.has("dry-run");

const READY = "agent:ready";
const BLOCKED = "agent:blocked";

// 0. 确保 label 存在（幂等）
if (!dryRun) {
  apiRaw(`repos/${repo}/labels`, [
    "-X",
    "POST",
    "-f",
    `name=${READY}`,
    "-f",
    "color=0E8A16",
    "-f",
    "description=图计算判定可干(kick/rollup)——仅索引提示,执行前必回GitHub重验(#1308)",
  ]);
  apiRaw(`repos/${repo}/labels`, [
    "-X",
    "POST",
    "-f",
    `name=${BLOCKED}`,
    "-f",
    "color=B0B0B0",
    "-f",
    "description=有open blocker,确定性SKIP(issue-graph图计算维护)",
  ]);
}

// 1. 跑图计算（脚本组合：单一真相源，不复制逻辑）
const scan = Bun.spawnSync(
  [
    "bun",
    `${import.meta.dir}/graph-scan.ts`,
    "--repo",
    repo,
    "--window-hours",
    String(windowHours),
  ],
  { stdout: "pipe", stderr: "pipe" },
);
if (scan.exitCode !== 0)
  throw new Error(`graph-scan failed: ${scan.stderr.toString().slice(0, 400)}`);
const graph = JSON.parse(scan.stdout.toString());

const holdSet = new Set<number>(
  graph.ready.filter((r: any) => r.hasHold).map((r: any) => r.number as number),
);
const blockedSet = new Set<number>(graph.blocked.map((b: any) => b.number as number));
const desiredReady = new Set<number>(
  [
    ...graph.kicks.map((k: any) => k.number),
    ...graph.rollupCandidates.map((r: any) => r.number),
  ].filter((n: number) => !holdSet.has(n) && !blockedSet.has(n)),
);

// 2. 现状：已带 label 的 issue（state=all——closed 上残留的 label 是必须清理的
//    陈旧队列噪音：issue 在图计算与打标之间被关闭是常态，环境非常活跃）
function labeled(label: string): { open: Set<number>; closed: Set<number> } {
  const open = new Set<number>();
  const closed = new Set<number>();
  for (const i of apiPaged(`repos/${repo}/issues?state=all&labels=${encodeURIComponent(label)}`)) {
    if (i.pull_request) continue;
    (i.state === "open" ? open : closed).add(i.number as number);
  }
  return { open, closed };
}
const currentReady = labeled(READY);
const currentBlocked = labeled(BLOCKED);

// 3. 对账
const actions: string[] = [];
function edit(n: number, op: "add" | "remove", label: string, reason: string) {
  actions.push(`${op === "add" ? "+" : "-"} ${label} #${n}（${reason}）`);
  if (dryRun) return;
  const r = apiRaw(
    op === "add"
      ? `repos/${repo}/issues/${n}/labels`
      : `repos/${repo}/issues/${n}/labels/${encodeURIComponent(label)}`,
    op === "add" ? ["-X", "POST", "-f", `labels[]=${label}`] : ["-X", "DELETE"],
  );
  if (!r.ok && !r.stderr.includes("404"))
    console.error(`label ${op} failed #${n}: ${r.stderr.slice(0, 150)}`);
}

// ready：加缺的
for (const n of desiredReady) {
  if (!currentReady.open.has(n) && !currentReady.closed.has(n)) {
    const why = graph.kicks.find((k: any) => k.number === n) ? "close-kick" : "rollup 候选";
    edit(n, "add", READY, why);
  }
}
// ready：清理失效（closed / hold / 变 blocked）；"不在本轮计算里"不摘（kick 瞬态，消费方处理完才摘）
for (const n of currentReady.closed) edit(n, "remove", READY, "issue 已关闭");
for (const n of currentReady.open) {
  if (holdSet.has(n)) edit(n, "remove", READY, "agent:hold 人类保留");
  else if (blockedSet.has(n)) edit(n, "remove", READY, "出现 open blocker");
}
// blocked：严格对账（blocked 是状态不是事件，可全量收敛）
for (const n of blockedSet)
  if (!currentBlocked.open.has(n)) edit(n, "add", BLOCKED, "有 open blocker");
for (const n of currentBlocked.open)
  if (!blockedSet.has(n)) edit(n, "remove", BLOCKED, "blocker 已全关");
for (const n of currentBlocked.closed) edit(n, "remove", BLOCKED, "issue 已关闭");

console.log(
  JSON.stringify(
    {
      repo,
      dryRun,
      stats: graph.stats,
      desiredReady: [...desiredReady],
      actions,
    },
    null,
    2,
  ),
);
