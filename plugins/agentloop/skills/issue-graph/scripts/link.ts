#!/usr/bin/env bun
/**
 * link — 写 issue 关系边（幂等）。
 *
 * 用法：
 *   bun link.ts --parent <N> --child <M> [--repo owner/name]     # 挂原生 sub-issue 父子边
 *   bun link.ts --issue <Y> --blocked-by <X> [--repo owner/name] # 挂依赖边（Y 被 X block）
 *
 * 幂等：边已存在（422）→ 视为成功。child 已有不同 parent → 报错退出
 * （GitHub 单 parent 约束；换 parent 是显式人类决定，不自动做）。
 *
 * agent 开 spin-off / 派生 issue 时必须调用（与 `<!-- spinoff-of: #N -->`
 * body 标记并存：标记留作 provenance，原生边供确定性图计算）。见 #1308。
 */
import { api, apiRaw, parseArgs, resolveRepo } from "./lib";

const args = parseArgs(Bun.argv.slice(2));
const repo = resolveRepo(args.get("repo") as string | undefined);

function issueDbId(n: number): number {
  return api(`repos/${repo}/issues/${n}`).id;
}

if (args.has("parent") && args.has("child")) {
  const parent = Number(args.get("parent"));
  const child = Number(args.get("child"));
  if (parent === child) throw new Error("parent == child，拒绝自环");

  // child 已有 parent？（404 = 没有）
  const existing = apiRaw(`repos/${repo}/issues/${child}/parent`);
  if (existing.ok) {
    const cur = JSON.parse(existing.stdout).number;
    if (cur === parent) {
      console.log(`OK（幂等）：#${child} 已是 #${parent} 的 sub-issue`);
      process.exit(0);
    }
    console.error(`CONFLICT：#${child} 已有不同 parent #${cur}（换 parent 需人决定，不自动做）`);
    process.exit(2);
  }

  const r = apiRaw(`repos/${repo}/issues/${parent}/sub_issues`, [
    "-X",
    "POST",
    "-F",
    `sub_issue_id=${issueDbId(child)}`,
  ]);
  if (r.ok) {
    console.log(`LINKED：#${child} → sub-issue of #${parent}`);
  } else if (r.stderr.includes("422")) {
    console.log(`OK（幂等）：边已存在 #${parent} ← #${child}`);
  } else {
    console.error(`FAILED：${r.stderr.slice(0, 300)}`);
    process.exit(1);
  }
} else if (args.has("issue") && args.has("blocked-by")) {
  const issue = Number(args.get("issue"));
  const blocker = Number(args.get("blocked-by"));
  if (issue === blocker) throw new Error("issue == blocked-by，拒绝自环");

  const r = apiRaw(`repos/${repo}/issues/${issue}/dependencies/blocked_by`, [
    "-X",
    "POST",
    "-F",
    `issue_id=${issueDbId(blocker)}`,
  ]);
  if (r.ok) {
    console.log(`LINKED：#${issue} blocked-by #${blocker}`);
  } else if (r.stderr.includes("422")) {
    console.log(`OK（幂等）：依赖边已存在 #${issue} blocked-by #${blocker}`);
  } else {
    console.error(`FAILED：${r.stderr.slice(0, 300)}`);
    process.exit(1);
  }
} else {
  console.error(
    "用法：link.ts --parent N --child M | --issue Y --blocked-by X（可选 --repo owner/name）",
  );
  process.exit(64);
}
