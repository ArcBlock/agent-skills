#!/usr/bin/env bun
/**
 * graph-scan — issue 关系图的确定性计算（只读）。
 *
 * 输出 JSON：ready set（成员确定、顺序按 hostname 旋转错峰）、blocked、
 * 父级 rollup 候选（全部孩子已关）、close-kick 集（近窗口关闭 → 反查
 * 仍 open 的 parent / 被解锁的 dependents）。
 *
 * 用法：
 *   bun graph-scan.ts [--repo owner/name] [--window-hours 2] [--pretty]
 *
 * 数据源：GitHub 原生图（sub_issues_summary / issue_dependencies_summary /
 * /parent / /dependencies/*）。spinoff HTML 标记不在此读取——它们由
 * backfill.ts 一次性迁成原生边，之后 link.ts 保证新边原生化。
 */
import { apiPaged, hostRotate, parseArgs, resolveRepo } from "./lib";

const args = parseArgs(Bun.argv.slice(2));
const repo = resolveRepo(args.get("repo") as string | undefined);
const windowHours = Number(args.get("window-hours") ?? 2);

// ---------- 1. 全部 open issue（issue 端点会混入 PR，用 pull_request 字段滤掉） ----------
const openRaw = apiPaged(`repos/${repo}/issues?state=open`);
const open = openRaw
  .filter((i: any) => !i.pull_request)
  .map((i: any) => ({
    number: i.number as number,
    title: i.title as string,
    labels: (i.labels ?? []).map((l: any) => l.name as string),
    subTotal: i.sub_issues_summary?.total ?? 0,
    subCompleted: i.sub_issues_summary?.completed ?? 0,
    blockedByCount: i.issue_dependencies_summary?.blocked_by ?? 0,
  }));

// ---------- 2. blocked 判定：只对 summary 显示有 blocker 的少数 issue 查明细 ----------
const blocked: { number: number; title: string; openBlockers: number[] }[] = [];
for (const iss of open.filter((i) => i.blockedByCount > 0)) {
  const deps = apiPaged(`repos/${repo}/issues/${iss.number}/dependencies/blocked_by`);
  const openBlockers = deps.filter((d: any) => d.state === "open").map((d: any) => d.number);
  if (openBlockers.length > 0) blocked.push({ number: iss.number, title: iss.title, openBlockers });
}
const blockedSet = new Set(blocked.map((b) => b.number));

// ---------- 3. ready set：open ∧ 无 open blocker；顺序按 hostname 旋转 ----------
const ready = hostRotate(
  open
    .filter((i) => !blockedSet.has(i.number))
    .map((i) => ({
      number: i.number,
      title: i.title,
      labels: i.labels,
      hasHold: i.labels.includes("agent:hold"),
    })),
);

// ---------- 4. 父级 rollup 候选：open ∧ 有孩子 ∧ 全部孩子已关 ----------
const rollupCandidates = open
  .filter((i) => i.subTotal > 0 && i.subCompleted === i.subTotal)
  .map((i) => ({ number: i.number, title: i.title, labels: i.labels, children: i.subTotal }));

// ---------- 5. close-kick：近窗口关闭的 issue → 反查 open 的 parent / dependents ----------
const cutoff = new Date(Date.now() - windowHours * 3600_000).toISOString();
const closedRaw = apiPaged(
  `repos/${repo}/issues?state=closed&sort=updated&direction=desc&since=${cutoff}`,
  3,
);
const recentlyClosed = closedRaw
  .filter((i: any) => !i.pull_request && i.closed_at && i.closed_at > cutoff)
  .map((i: any) => ({
    number: i.number as number,
    closedAt: i.closed_at as string,
    blocking: i.issue_dependencies_summary?.blocking ?? 0,
  }));

const kickReasons = new Map<number, string[]>();
function addKick(target: number, reason: string) {
  if (!kickReasons.has(target)) kickReasons.set(target, []);
  kickReasons.get(target)!.push(reason);
}
for (const c of recentlyClosed) {
  // parent（404 = 无 parent）
  const p = Bun.spawnSync(["gh", "api", `repos/${repo}/issues/${c.number}/parent`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode === 0) {
    const parent = JSON.parse(p.stdout.toString());
    if (parent.state === "open") addKick(parent.number, `原生 parent of 已关 #${c.number}`);
  }
  // 被它 block 的 dependents（summary 有才查明细）
  if (c.blocking > 0) {
    const deps = apiPaged(`repos/${repo}/issues/${c.number}/dependencies/blocking`);
    for (const d of deps) {
      if (d.state === "open") addKick(d.number, `blocker #${c.number} 已关，可能解锁`);
    }
  }
}
const openByNumber = new Map(open.map((i) => [i.number, i]));
const kicks = [...kickReasons.entries()]
  .filter(([n]) => openByNumber.has(n))
  .map(([n, reasons]) => ({
    number: n,
    title: openByNumber.get(n)!.title,
    reasons,
    stillBlocked: blockedSet.has(n),
  }));

// ---------- 输出 ----------
const report = {
  repo,
  generatedAt: new Date().toISOString(),
  windowHours,
  stats: {
    open: open.length,
    ready: ready.length,
    blocked: blocked.length,
    rollupCandidates: rollupCandidates.length,
    recentlyClosed: recentlyClosed.length,
    kicks: kicks.length,
  },
  ready,
  blocked,
  rollupCandidates,
  kicks,
};
console.log(JSON.stringify(report, null, args.has("pretty") ? 2 : 0));
