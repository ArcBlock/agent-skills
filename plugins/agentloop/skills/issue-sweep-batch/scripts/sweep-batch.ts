#!/usr/bin/env bun
/**
 * issue-sweep-batch — 机械层。
 *
 * 本脚本**只做可判定的部分**，把需要判断的部分显式交回给 agent：
 *
 *   机械（这里做）        存量拉取 / ledger 增量 / 路径面抽取 / 三态不相交 / 认领排除
 *   判断（agent 做）      缺陷层归属 / unproven 的读码定位 / epic 正文 / 成员取舍
 *
 * 这个分工是刻意的。把「缺陷层」交给脚本用关键词猜，就会重演 #5487（共享 worker 槽位）
 * 与 #4749（独占 heavy lease）被症状词捆在一起、产出「既共享又独占」的错误。
 *
 * ## 来源可换
 *
 * 工作项从 `WorkItemSource`（见 `source.ts`）来，不直接绑 GitHub。今天是
 * `GitHubIssueSource`；work object（arc #5540）落地后换 `WorkObjectSource`，
 * 判定核心一行不改。两个源过同一套 `source.conformance.test.ts`。
 *
 * 用法：
 *   bun sweep-batch.ts --dry-run                      只打印，不写 ledger、不建 issue
 *   bun sweep-batch.ts --types bug,feature,idea       扫哪些类型（默认 bug）
 *   bun sweep-batch.ts --mode new                     只处理从未分类的（反复归类没动的是纯浪费）
 *   bun sweep-batch.ts --mode revalidate              只重验已分类的（世界变了之后旧结论还成立吗）
 *   bun sweep-batch.ts --dry-run --scope factory      只看工厂树的候选
 *   bun sweep-batch.ts --source work-object           换源（落地前会 fail-closed）
 *   bun sweep-batch.ts --html out.html                同时产出可交互的 HTML（双击就能开）
 *   bun sweep-batch.ts --ledger <path>                指定 ledger 位置
 *
 * 非 --dry-run 目前只多做一件事：写 ledger。**建 epic 始终由 agent 执行**，
 * 因为 epic 正文需要判断，而脚本写出来的模板化正文正是我们要避免的东西。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  axisFor,
  groupingQuestion,
  type Mode,
  revalidationReasons,
  shouldProcess,
  typeOf,
  type WorkType,
} from "./classify";
import {
  agingBuckets,
  assess,
  backlogSlope,
  flowRatio,
  type HealthItem,
  netToCumulative,
} from "./health";
import { type Model, type Overview, renderHtml } from "./html";
import {
  disjointness,
  fingerprint,
  isSelfMember,
  type LedgerRecord,
  type PathSurface,
  pathSurface,
} from "./lib";
import {
  capabilitiesOf,
  GitHubIssueSource,
  type WorkItem,
  type WorkItemSource,
  WorkObjectSource,
} from "./source";
import {
  bucketFlow,
  bucketsFor,
  type Granularity,
  stockSeries,
  type TimedItem,
  typeTotals,
} from "./stats";
import {
  coverage,
  type Decision,
  decisionGroups,
  deriveRules,
  proposeType,
  replayGuard,
  singletons,
  type Untyped,
} from "./typing";

const args = process.argv.slice(2);
const flag = (name: string, dflt: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const DRY = args.includes("--dry-run");
const SCOPE = flag("--scope", "all");
const TYPES = flag("--types", "bug")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean) as WorkType[];
const MODE = flag("--mode", "all") as Mode;
const SOURCE = flag("--source", "github");
const LEDGER = flag("--ledger", ".claude/state/sweep-batch-ledger.json");
const HTML = flag("--html", "");
const JSON_OUT = flag("--json", "");
const STATS_DAYS = Number(flag("--stats-days", "30"));
const TTL_DAYS = 14;

function repoSlug(): string {
  // repo-profile 的 repo_slug 是权威；没有就从 git remote 推。
  try {
    const prof = readFileSync(".claude/repo-profile.md", "utf8");
    const m = prof.match(/repo_slug[`*\s:|]+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
    if (m) return m[1];
  } catch {
    /* 没有 profile 就往下推 */
  }
  const url = Bun.spawnSync(["git", "remote", "get-url", "origin"], { stdout: "pipe" })
    .stdout.toString()
    .trim();
  const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  if (!m) throw new Error("无法确定 repo：既无 repo-profile 的 repo_slug，也解析不出 git remote");
  return m[1];
}

function makeSource(): { src: WorkItemSource; label: string } {
  if (SOURCE === "work-object") return { src: new WorkObjectSource(), label: "work-object" };
  const repo = repoSlug();
  return { src: new GitHubIssueSource(repo), label: `github:${repo}` };
}

/* ===== 候选集 ===== */

const NON_BUG = [
  "idea",
  "research",
  "feature",
  "enhancement",
  "documentation",
  "planning",
  "design",
  "nightly-test-report",
  "test-sweep-report",
  "reference",
  "ux",
];
const HUMAN_BLOCKED = ["needs-human-confirm", "needs-decision", "agent:hold"];

const FACTORY_TREE =
  /^(\.claude\/|scripts\/|tools\/|providers\/runtime\/code-agents\/|blocklets\/code-agents)/;

function inScope(s: PathSurface): boolean {
  if (SCOPE !== "factory") return true;
  return s.files.some((f) => FACTORY_TREE.test(f));
}

/* ===== 主流程 ===== */

const { src, label } = makeSource();
const caps = capabilitiesOf(src);

const all = await src.list({ state: "open" });
const claimed = await src.claimedIds();
const epicMembers = await src.epicMembers();

const candidates: WorkItem[] = [];
const rejected: Record<string, number[]> = {
  "已在 epic": [],
  卡在人身上: [],
  在飞工作已认领: [],
  "epic 自身": [],
};

for (const i of all) {
  const L = new Set(i.labels);
  if (i.title.startsWith("[epic]") || L.has("epic")) {
    rejected["epic 自身"].push(i.id);
    continue;
  }
  const t = typeOf(i.labels);
  if (!TYPES.includes(t)) {
    rejected[`类型不在 --types（${t}）`] = [...(rejected[`类型不在 --types（${t}）`] ?? []), i.id];
    continue;
  }
  if (HUMAN_BLOCKED.some((x) => L.has(x))) {
    rejected["卡在人身上"].push(i.id);
    continue;
  }
  if (MODE === "new" && [...L].some((x) => /^epic:\d+$/.test(x))) {
    rejected["已在 epic（--mode new 跳过）"] = [
      ...(rejected["已在 epic（--mode new 跳过）"] ?? []),
      i.id,
    ];
    continue;
  }
  if (claimed.has(i.id)) {
    rejected["在飞工作已认领"].push(i.id);
    continue;
  }
  // --scope 必须作用在**候选集**上，不能只影响显示：
  // 否则出范围的项照样参与 ledger delta，非 dry-run 还会被写进 ledger。
  // （Codex 在 #5628 的评审里指出，成立。）
  if (!inScope(pathSurface(i.body))) {
    rejected[`不在 --scope ${SCOPE}`] = [...(rejected[`不在 --scope ${SCOPE}`] ?? []), i.id];
    continue;
  }
  candidates.push(i);
}

// ledger 增量
let ledger: LedgerRecord[] = [];
if (existsSync(LEDGER)) {
  try {
    ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
  } catch {
    ledger = [];
  }
}

/* --mode 的真正落点：逐条算「为什么需要（重新）分类」，再按模式取舍。
   没有邻域信号时 quiet 是诚实的空值——上面已经打过警告说这一类会漏。 */
const nbMap = caps.neighborhood && src.neighborhood ? await src.neighborhood(24) : new Map();
const now = new Date();
const reasonsById = new Map<number, string[]>();
const everClassified = new Map<number, boolean>();
const ledgerById = new Map(ledger.map((r) => [r.issue, r]));
for (const i of candidates) {
  const rec = ledgerById.get(i.id);
  const nb = nbMap.get(i.id) ?? { closedNeighbors: [], unblockedBy: [] };
  const classified = Boolean(rec?.layer);
  everClassified.set(i.id, classified);
  reasonsById.set(
    i.id,
    revalidationReasons(
      {
        issue: i.id,
        fingerprint: rec?.fingerprint ?? "",
        classifiedAt: rec?.classifiedAt ?? new Date(0).toISOString(),
        layer: rec?.layer ?? null,
      },
      fingerprint(i.body, i.labels),
      { ...nb, newHumanInput: false },
      TTL_DAYS,
      now,
    ),
  );
}
const selected = candidates.filter((i) =>
  shouldProcess(MODE, everClassified.get(i.id) ?? false, reasonsById.get(i.id) ?? []),
);
const skippedByMode = candidates.length - selected.length;

// 在飞 epic 的合并路径面
const byId = new Map(all.map((i) => [i.id, i]));
const liveEpicSurface = new Map<number, PathSurface>();
for (const [epic, members] of epicMembers) {
  const bodies = members.map((m) => byId.get(m)?.body ?? "").join("\n");
  liveEpicSurface.set(epic, pathSurface(bodies));
}

/* ===== 报告 ===== */

const surf = new Map<number, PathSurface>();
for (const i of selected) surf.set(i.id, pathSurface(i.body));

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
console.log(
  `\n${B("issue-sweep-batch")}  源=${label}  类型=${TYPES.join(",")}  模式=${MODE}  scope=${SCOPE}  ${DRY ? "(dry-run)" : ""}`,
);
console.log(
  `  能力：下推=${caps.pushdown} 增量=${caps.incremental} 可写分类=${caps.writableClassification} 邻域=${caps.neighborhood}`,
);
if (!caps.neighborhood) {
  console.log("  ⚠ 本源无邻域信号：只能看见工作项**自身**的变化。「邻居合了导致旧分类不成立」");
  console.log(
    "    这一类会整类漏掉。GitHub 下需先跑 issue-graph 的 graph-scan.ts 补 kicks（SKILL Step 1.5）。",
  );
}
if (!caps.pushdown) {
  console.log("  ⚠ 本源不支持下推：每轮取全量再本地过滤。work object 落地后这一步会便宜很多。");
}
console.log(
  `  存量 ${all.length} · 候选 ${candidates.length} · 本模式选中 ${selected.length}（模式跳过 ${skippedByMode}） · 在飞 epic ${liveEpicSurface.size}`,
);
console.log(`  ledger ${existsSync(LEDGER) ? `${ledger.length} 条` : "（不存在，本轮全量）"}`);
{
  // 按「为什么需要重新分类」分布，而不是两个会互相打架的计数。
  const hist = new Map<string, number>();
  for (const rs of reasonsById.values()) {
    if (rs.length === 0) hist.set("无需重做（跳过）", (hist.get("无需重做（跳过）") ?? 0) + 1);
    for (const r of rs) {
      const key = r.split("（")[0].split("：")[0];
      hist.set(key, (hist.get(key) ?? 0) + 1);
    }
  }
  for (const [k, v] of [...hist].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${String(v).padStart(4)}  ${k}`);
  }
}

console.log(`\n${B("排除")}`);
for (const [k, v] of Object.entries(rejected))
  if (v.length) console.log(`  ${k.padEnd(16)} ${v.length}`);

// scope 已在候选集上生效，这里不再重复过滤。
const measured = selected.filter((i) => surf.get(i.id)!.state === "measured");
const partial = selected.filter((i) => surf.get(i.id)!.state === "partial");
const unproven = selected.filter((i) => surf.get(i.id)!.state === "unproven");

console.log(`\n${B("路径面已测（可参与不相交判定）")}  ${measured.length} 条`);
const byLane = new Map<string, WorkItem[]>();
for (const i of measured) {
  for (const lane of surf.get(i.id)!.lanes) byLane.set(lane, [...(byLane.get(lane) ?? []), i]);
}
for (const [lane, is] of [...byLane].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${lane}`);
  for (const i of is) console.log(`      #${i.id}  ${i.title.slice(0, 56)}`);
}

if (partial.length) {
  console.log(`\n${B("★ partial —— 抽到了落点，但正文里还有未识别的路径")}  ${partial.length} 条`);
  console.log("  不完整的落点不足以证明不相交。已识别的冲突仍然作数，未识别的部分需读代码补。");
  for (const i of partial) {
    const u = surf.get(i.id)!.unrecognized.slice(0, 2).join(", ");
    console.log(`      #${i.id}  ${i.title.slice(0, 44)}   未识别: ${u}`);
  }
}

console.log(`\n${B("★ unproven —— 正文无路径，派前必须读代码定位")}  ${unproven.length} 条`);
console.log("  这些不等于「与谁都不相交」。把它们当 disjoint 派出去，正是本 skill 要防的错。");
for (const i of unproven) console.log(`      #${i.id}  ${i.title.slice(0, 56)}`);

console.log(`\n${B("与在飞 epic 的不相交判定")}`);
for (const [epic, es] of liveEpicSurface) {
  const mem = epicMembers.get(epic) ?? [];
  // 成员与自己所属的 epic 报冲突是同一份工作，不是撞车。
  const rows = measured
    .filter((i) => !isSelfMember(i.id, mem))
    .map((i) => ({ i, r: disjointness(surf.get(i.id)!, es) }));
  const ov = rows.filter((x) => x.r.state === "overlap");
  const dj = rows.filter((x) => x.r.state === "disjoint").length;
  const up = rows.filter((x) => x.r.state === "unproven").length;
  console.log(
    `  epic #${epic}  (${epicMembers.get(epic)!.length} 成员, 落点 ${es.files.length} 文件)`,
  );
  console.log(`      disjoint ${dj} · overlap ${ov.length} · unproven ${up}`);
  for (const x of ov) console.log(`      ⚠ #${x.i.id} 撞 ${x.r.shared.join(", ")}`);
}

console.log(`\n${B("交回给 agent 判断的")}`);
for (const t of TYPES) {
  const ax = axisFor(t);
  console.log(
    `  · ${t} → 轴=${ax ?? "（无轴，必须先定类型）"}　判据：${groupingQuestion(t) || "—"}`,
  );
}
console.log("");
console.log("  1. 给每条候选赋 layer —— 按上面各类型自己的轴，脚本刻意不猜");
console.log(`  2. 读代码定位 ${unproven.length} 条 unproven 的落点`);
console.log("  3. 按 layer 聚簇，簇内再验一次文件级不相交");
console.log("  4. 写 epic 正文（主题一句话 / 成员表 / 只碰-不碰 / 逐条 mutation pair / 3 轮上限）");
console.log("  5. 建完自检 body 长度 > 0（G1），摘掉 epic 自标签（G4）\n");

/* ===== 归类：消灭 untyped ===== */
// 已有类型的项 = 既有判断（label 是人/agent 挂的，这里当作既有事实）。
// 只有它们能长规则；agent 本轮的提议**不回流**，否则第一次猜错会自我强化。
const priorDecisions: Decision[] = [];
const untypedItems: Untyped[] = [];
for (const i of all) {
  if (i.title.startsWith("[epic]") || i.labels.includes("epic")) continue;
  const t = typeOf(i.labels);
  const rec = { id: i.id, title: i.title, body: i.body ?? "", labels: i.labels };
  if (t === "untyped") untypedItems.push(rec);
  else if (t !== "report")
    priorDecisions.push({ ...rec, type: t as Decision["type"], by: "human" });
}
const derivedRules = deriveRules(priorDecisions);
const activeRules = replayGuard(derivedRules, priorDecisions);
const cov = coverage(untypedItems, activeRules);
const stillUnknown = untypedItems.filter((u) => !proposeType(u, activeRules).type);
const groups = decisionGroups(stillUnknown, activeRules);
const lonely = singletons(stillUnknown, groups);

if (untypedItems.length > 0) {
  const pct = ((untypedItems.length / all.length) * 100).toFixed(0);
  console.log(`\n${B("归类 · untyped")} ${untypedItems.length}/${all.length}（${pct}%）`);
  console.log(
    `  规则 ${derivedRules.length} 条派生 → 回放守卫保留 ${activeRules.length}` +
      `（拒绝 ${derivedRules.length - activeRules.length}）`,
  );
  console.log(
    `  可自动归类 ${cov.auto}（${(cov.ratio * 100).toFixed(0)}%） · 仍需人断 ${cov.needsHuman}`,
  );
  if (groups.length) {
    let acc = 0;
    console.log(`\n  批量判断单 —— ${groups.length} 次判断覆盖：`);
    for (const [n, g] of groups.entries()) {
      acc += g.ids.length;
      console.log(
        `    ${String(n + 1).padStart(2)}. +${String(g.ids.length).padStart(2)} 累计 ${String(acc).padStart(2)}` +
          `  ${g.feature}  齐${Math.round(g.homogeneity * 100)}%` +
          `${g.homogeneity < 0.5 ? " ⚠杂" : ""}${g.hint ? `  （提示：${g.hint}）` : ""}`,
      );
    }
    console.log(`  剩 ${lonely.length} 条无共享特征，只能逐条看 —— 不假装它们能批量。`);
  }
}

let overview: Overview | undefined;
if (HTML) {
  // 概览需要**已关闭**的项才能画流量/存量。GitHub 下这是额外一次昂贵拉取。
  if (src.timeline) {
    const rows = await src.timeline(STATS_DAYS);
    const timed: TimedItem[] = rows.map((r) => ({
      id: r.id,
      type: typeOf(r.labels),
      createdAt: r.createdAt,
      closedAt: r.closedAt,
    }));
    const t = typeTotals(timed);
    const series: Overview["series"] = {};
    for (const g of ["hour", "day", "week", "month"] as Granularity[]) {
      const b = bucketsFor(g, new Date());
      const f = bucketFlow(timed, b);
      const st = stockSeries(timed, b);
      series[g] = {
        labels: b.map((x) => x.label),
        opened: f.map((x) => x.opened),
        closed: f.map((x) => x.closed),
        stock: st.map((x) => x.open),
      };
    }
    overview = {
      total: t.total,
      byType: t.byType,
      unknownTypes: t.unknownTypes,
      series,
      windowNote:
        `已关闭项只取最近 ${STATS_DAYS} 天（${rows.filter((r) => r.closedAt).length} 条）——` +
        `更早的关闭不在窗口内，存量线的左端会因此偏低。` +
        (caps.incremental ? "" : " 本源不支持增量，这是每轮全量拉取的结果。"),
    };
    console.log(
      `概览：${rows.length} 条带时间戳（含已关闭 ${rows.filter((r) => r.closedAt).length}）`,
    );
  } else {
    console.log("⚠ 本源不提供 timeline：概览页会显示「未采集」而不是画一张空图。");
  }

  // 健康判读：detector 是确定性的，agent 该读它的结构化输出而不是截图。
  let health: ReturnType<typeof assess> | undefined;
  let aging: ReturnType<typeof agingBuckets> | undefined;
  if (src.timeline) {
    const rows = await src.timeline(STATS_DAYS);
    const hItems: HealthItem[] = rows.map((r) => ({
      id: r.id,
      type: typeOf(r.labels),
      createdAt: r.createdAt,
      closedAt: r.closedAt,
    }));
    // 用净值累加，不用 stock 序列——后者左端受关闭窗口影响而系统性偏低，
    // 会把测量伪影读成「存量在涨」（实测 +16.4/天，而净值其实在转负）。
    const day7 = overview?.series.day;
    const net7 = day7 ? day7.opened.slice(-7).map((o, k) => o - day7.closed.slice(-7)[k]) : [];
    const stock7d = netToCumulative(net7);
    const hin = {
      now: new Date(),
      items: hItems,
      stock7d,
      untyped: untypedItems.length,
      total: hItems.filter((x) => !x.closedAt).length,
    };
    health = assess(hin);
    aging = agingBuckets(hItems, hin.now);
    const icon = health.status === "healthy" ? "🟢" : health.status === "degraded" ? "🟡" : "🔴";
    const f = flowRatio(hin);
    console.log(`\n${B(`${icon} ${health.status.toUpperCase()}`)}  ${health.headline}`);
    for (const e of health.explanations) console.log(`    · ${e}`);
    console.log(
      `    7d 新建 ${f.created} / 关闭 ${f.closed}（比值 ${f.ratio.toFixed(2)}）` +
        ` · 存量斜率 ${backlogSlope(stock7d).toFixed(1)}/天` +
        ` · 年龄 ${Object.entries(aging)
          .map(([k, v]) => `${k}:${v}`)
          .join(" ")}`,
    );
    console.log(`    需要人介入：${health.humanAttention ? "是" : "**否**"}`);
  }

  const ghUrl = (n: number) => `https://github.com/${label.replace(/^github:/, "")}/issues/${n}`;
  const overlaps: Model["overlaps"] = [];
  for (const [epic, es] of liveEpicSurface) {
    for (const i of measured) {
      const r = disjointness(surf.get(i.id)!, es);
      if (r.state === "overlap") overlaps.push({ item: i.id, epic, shared: r.shared });
    }
  }
  const model: Model = {
    overview,
    health,
    aging,
    typing: {
      untyped: untypedItems.length,
      total: all.length,
      autoRatio: cov.ratio,
      rulesDerived: derivedRules.length,
      rulesActive: activeRules.length,
      rules: activeRules.slice(0, 20),
      groups: groups.map((g) => ({
        feature: g.feature,
        hint: g.hint,
        ids: g.ids,
        titles: g.titles.map((t) => t.slice(0, 70)),
        homogeneity: g.homogeneity,
      })),
      singletons: lonely,
    },
    generatedAt: new Date().toISOString().replace("T", " ").slice(0, 16),
    repo: label.replace(/^github:/, ""),
    source: label,
    types: TYPES,
    mode: MODE,
    capabilities: {
      pushdown: caps.pushdown,
      incremental: caps.incremental,
      writableClassification: caps.writableClassification,
      neighborhood: caps.neighborhood,
    },
    totals: {
      all: all.length,
      candidates: candidates.length,
      selected: selected.length,
      skipped: skippedByMode,
    },
    // 可视化带**全部类型**，不只是本轮 --types 选中的那批：
    // 否则点「feature」卡片会得到一张空页（实测的 UI bug）。
    // selected 标记本轮是否进了分类流程，视图里用它区分。
    items: all
      .filter((i) => !i.title.startsWith("[epic]") && !i.labels.includes("epic"))
      .map((i) => {
        const s2 = surf.get(i.id) ?? pathSurface(i.body);
        return {
          id: i.id,
          title: i.title,
          type: typeOf(i.labels),
          lanes: s2.lanes,
          files: s2.files,
          surfaceState: s2.state,
          reasons: reasonsById.get(i.id) ?? [],
          epic: Number(i.labels.find((l) => /^epic:\d+$/.test(l))?.slice(5)) || null,
          selected: selected.some((x) => x.id === i.id),
          url: ghUrl(i.id),
        };
      }),
    axes: Object.fromEntries(
      (["bug", "feature", "idea", "research", "report", "untyped"] as WorkType[]).map((t) => [
        t,
        { axis: axisFor(t), question: groupingQuestion(t) },
      ]),
    ),
    epics: [...liveEpicSurface].map(([id, es]) => ({
      id,
      title: byId.get(id)?.title ?? `epic #${id}`,
      members: epicMembers.get(id) ?? [],
      files: es.files,
      url: ghUrl(id),
    })),
    overlaps,
  };
  mkdirSync(dirname(HTML), { recursive: true });
  writeFileSync(HTML, renderHtml(model));
  if (JSON_OUT) {
    // agent 读这个，不读截图。渲染 → 视觉理解 → 推理会再加一层不必要的噪声。
    mkdirSync(dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify(model, null, 2));
    console.log(`JSON 已写 ${JSON_OUT}（agent 读这个，不读截图）`);
  }
  console.log(
    `HTML 已写 ${HTML}（${model.items.length} 条 · ${model.epics.length} epic · ${overlaps.length} 处冲突）`,
  );
}

if (!DRY) {
  const now = new Date().toISOString();
  const next: LedgerRecord[] = [
    ...ledger.filter((r) => !selected.some((x) => x.id === r.issue)),
    ...candidates
      .filter((i) => selected.some((x) => x.id === i.id))
      .map((i) => ({
        issue: i.id,
        fingerprint: fingerprint(i.body, i.labels),
        classifiedAt: now,
        layer: null,
        pathSurface: surf.get(i.id)!.files,
        surfaceState: surf.get(i.id)!.state,
        epic: null,
        outcome: "open",
        exclusionReason: null,
      })),
  ];
  mkdirSync(dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, JSON.stringify(next, null, 2));
  console.log(`ledger 已写 ${LEDGER}（${next.length} 条）\n`);
} else {
  console.log("dry-run：未写 ledger、未建任何 issue。\n");
}
