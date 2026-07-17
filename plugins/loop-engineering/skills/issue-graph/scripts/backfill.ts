#!/usr/bin/env bun
/**
 * backfill — 把存量 `<!-- spinoff-of: #N -->` body 标记迁成原生 sub-issue 边。
 * 一次性迁移工具，幂等可重跑（已有边/已有 parent 的自动跳过）。见 #1308 Phase 2。
 *
 * 用法：
 *   bun backfill.ts [--repo owner/name] [--limit N]   # 默认 dry-run，只打印拟写入
 *   bun backfill.ts --execute                          # 真实写入（限速 ~1 边/秒）
 *
 * 安全规则：
 *   - child 已有相同 parent → 跳过（幂等 OK）
 *   - child 已有不同 parent → 跳过并报告（换 parent 是人类决定）
 *   - parent 不存在 / 是 PR → 跳过并报告
 *   - 单 parent >100 孩子（GitHub 上限）→ 超出部分跳过并报告
 */
import { apiPaged, apiRaw, parseArgs, resolveRepo } from "./lib";

const args = parseArgs(Bun.argv.slice(2));
const repo = resolveRepo(args.get("repo") as string | undefined);
const execute = args.has("execute");
const limit = args.has("limit") ? Number(args.get("limit")) : Infinity;

// 1. 搜索带 spinoff-of 的 issue（REST search，分页；search 上限 1000 条足够）
const q = encodeURIComponent(`repo:${repo} "spinoff-of" in:body is:issue`);
const items = apiPaged(`search/issues?q=${q}`, 10);

// 2. 解析标记 → 边
interface Edge {
  child: number;
  childDbId: number;
  childState: string;
  parent: number;
}
const edges: Edge[] = [];
for (const it of items) {
  const m = it.body?.match(/<!--\s*spinoff-of:\s*#(\d+)/);
  if (!m) continue;
  const parent = Number(m[1]);
  if (parent === it.number) continue; // 自环，忽略
  edges.push({ child: it.number, childDbId: it.id, childState: it.state, parent });
}
edges.sort((a, b) => a.child - b.child); // 确定性顺序，可重跑可对账

console.log(`repo=${repo} 搜索命中 ${items.length} 条，解析出 ${edges.length} 条 spinoff 边`);

// 3. 逐边检查 + 写入
const byParentCount = new Map<number, number>();
const result = { linked: 0, alreadyOk: 0, conflict: 0, parentMissing: 0, capSkipped: 0, failed: 0 };
let processed = 0;

for (const e of edges) {
  if (processed >= limit) break;
  processed++;

  // parent 侧现有孩子数（上限守卫；只在接近时才精确查）
  const cnt = (byParentCount.get(e.parent) ?? 0) + 1;
  byParentCount.set(e.parent, cnt);
  if (cnt > 100) {
    console.log(`SKIP cap：#${e.parent} 孩子将超 100 上限，跳过 #${e.child}`);
    result.capSkipped++;
    continue;
  }

  // child 现有 parent？
  const existing = apiRaw(`repos/${repo}/issues/${e.child}/parent`);
  if (existing.ok) {
    const cur = JSON.parse(existing.stdout).number;
    if (cur === e.parent) {
      result.alreadyOk++;
      continue;
    }
    console.log(`SKIP conflict：#${e.child} 已有不同 parent #${cur}（标记指向 #${e.parent}）`);
    result.conflict++;
    continue;
  }

  // parent 存在且是 issue？
  const p = apiRaw(`repos/${repo}/issues/${e.parent}`);
  if (!p.ok || JSON.parse(p.stdout).pull_request) {
    console.log(`SKIP parent-missing：#${e.parent} 不存在或是 PR（child #${e.child}）`);
    result.parentMissing++;
    continue;
  }

  if (!execute) {
    console.log(`DRY-RUN：would link #${e.child}（${e.childState}）→ sub-issue of #${e.parent}`);
    result.linked++;
    continue;
  }

  const r = apiRaw(`repos/${repo}/issues/${e.parent}/sub_issues`, [
    "-X",
    "POST",
    "-F",
    `sub_issue_id=${e.childDbId}`,
  ]);
  if (r.ok) {
    console.log(`LINKED：#${e.child} → sub-issue of #${e.parent}`);
    result.linked++;
  } else if (r.stderr.includes("422")) {
    result.alreadyOk++;
  } else {
    console.log(`FAILED：#${e.child} → #${e.parent}：${r.stderr.slice(0, 200)}`);
    result.failed++;
  }
  await Bun.sleep(1000); // 限速：content-creation ≤80/min，1 边/秒稳在其下
}

console.log(
  `\n${execute ? "执行" : "DRY-RUN"}汇总：linked=${result.linked} alreadyOk=${result.alreadyOk} ` +
    `conflict=${result.conflict} parentMissing=${result.parentMissing} ` +
    `capSkipped=${result.capSkipped} failed=${result.failed}`,
);
if (result.failed > 0) process.exit(1);
