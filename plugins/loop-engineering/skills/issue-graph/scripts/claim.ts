#!/usr/bin/env bun
/**
 * claim — claim-comment fencing：无分支兜底的终态动作（如父级 rollup）的
 * 多机互斥原语。#1308 Phase 0 实测通过。
 *
 * 为什么需要它：label 添加无 CAS，`agent:processing` 是 advisory（两机秒级
 * 内可双拿）；产出 PR 的工作有确定性分支碰撞兜底，但 comment+close 类终态
 * 动作没有。comment 流是 GitHub 唯一 append-only 全序原语（comment id 单调），
 * 用它裁决：先写后读，最早的未过期 claim 赢——两台机器算出同一个 winner。
 *
 * 用法：
 *   bun claim.ts --issue <N> --action <slug> [--ttl 1800] [--repo owner/name]
 *     赢：stdout JSON {won:true, claimId, runId}，exit 0
 *     输：自动删除自己的 claim，stdout {won:false, winnerClaimId}，exit 3
 *   bun claim.ts --release <claimId> [--repo owner/name]
 *     动作完成后删除自己的 claim comment（收尾必做；崩溃靠 TTL 过期兜底）
 *
 * 协议（调用方纪律）：
 *   1. claim 前先检查动作是否已做过（如 rollup marker comment / issue 已关）；
 *   2. 赢了才执行动作；动作前最后重读一次目标状态（已关/已变 → 放弃）；
 *   3. 完成后 --release。
 */
import { api, apiPaged, parseArgs, resolveRepo } from "./lib";

const args = parseArgs(Bun.argv.slice(2));
const repo = resolveRepo(args.get("repo") as string | undefined);

const MARKER = "agent-claim:";

if (args.has("release")) {
  const id = Number(args.get("release"));
  api(`repos/${repo}/issues/comments/${id}`, ["-X", "DELETE"]);
  console.log(JSON.stringify({ released: id }));
  process.exit(0);
}

const issue = Number(args.get("issue"));
const action = String(args.get("action") ?? "");
const ttl = Number(args.get("ttl") ?? 1800);
if (!issue || !action) {
  console.error("用法：claim.ts --issue N --action <slug> [--ttl 秒] | --release <claimId>");
  process.exit(64);
}

const host = process.env.HOSTNAME ?? Bun.spawnSync(["hostname"]).stdout.toString().trim();
const runId = `${host}-${process.pid}-${Date.now()}`;
const body = `<!-- ${MARKER} ${JSON.stringify({ action, run: runId, ts: new Date().toISOString(), ttl })} -->`;

// 1. post 自己的 claim
const mine = api(`repos/${repo}/issues/${issue}/comments`, ["-X", "POST", "-F", `body=${body}`]);

// 2. 重读全部同 action 的未过期 claim（先写后读：后写者必见先写者）
const cutoffMs = Date.now() - ttl * 1000;
const comments = apiPaged(`repos/${repo}/issues/${issue}/comments`);
const freshClaims = comments
  .filter((c: any) => typeof c.body === "string" && c.body.includes(MARKER))
  .map((c: any) => {
    const m = c.body.match(/agent-claim:\s*(\{.*?\})\s*-->/);
    let meta: any = null;
    try {
      meta = m ? JSON.parse(m[1]) : null;
    } catch {}
    return { id: c.id as number, createdAt: c.created_at as string, meta };
  })
  .filter((c) => c.meta?.action === action && new Date(c.createdAt).getTime() > cutoffMs);

// 3. 裁决：最小 comment id 赢（id 单调 = 全序）
const winner = freshClaims.reduce((a, b) => (a.id < b.id ? a : b), freshClaims[0]);
if (winner && winner.id === mine.id) {
  console.log(JSON.stringify({ won: true, claimId: mine.id, runId }));
  process.exit(0);
} else {
  // 输了：删自己的 claim，退出
  api(`repos/${repo}/issues/comments/${mine.id}`, ["-X", "DELETE"]);
  console.log(JSON.stringify({ won: false, winnerClaimId: winner?.id ?? null, runId }));
  process.exit(3);
}
