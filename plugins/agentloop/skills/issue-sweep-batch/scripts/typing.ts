/**
 * 消灭 untyped —— 三段式，外加一条让它**真的**变聪明的纪律。
 *
 * arc 实测：301 条 open 里 96 条（32%）没有任何类型标签，而且 untyped 是**最大**的
 * 单个类别。这不是洁癖问题：分类决定后面的 routing / priority / verification /
 * repair policy。对一个自主系统，「不知道自己 1/3 的库存是什么」比对人类团队严重得多。
 * 它与「`FAILED` 太粗」（#5560）是同一类缺陷——**结果面的词汇不足以推出下一步**。
 *
 * ## 三段
 *
 *   1. 有证据的自动判  proposeType()：命中规则才提议，**没证据就说不知道**
 *   2. 真歧义批量给人  剩下的按「提议的类型」分组，人一次决定一批
 *   3. 人的判断沉淀    deriveRules()：只从**人类**判断长规则
 *
 * ## 让「学习」可证伪（否则它与没有学习完全同色）
 *
 * 一个从不改变未来行为的学习机制，和没有机制，在报告上一模一样。三条钉死：
 *
 * - **只从人类判断学**（`by: "human"`）。学 agent 自己的提议会让第一次猜错自我强化。
 * - **`replayGuard`**：拿**全部**人类判断回放每一条规则，会预测错任何一条就拒绝。
 *   人自己不一致的前缀不得成规则。
 * - **`coverage`**：学习有没有真发生，看这个数。加入新规则后覆盖率必须**严格上升**——
 *   这是 accept 臂，钉住「全部拒绝」那个方向（全拒满足每一条 reject 断言）。
 */

export type WorkTypeName = "bug" | "feature" | "idea" | "research" | "report";

export interface Untyped {
  id: number;
  title: string;
  body: string;
  labels: string[];
}

/** 一条人类（或 agent）做出的归类判断。 */
export interface Decision extends Untyped {
  type: WorkTypeName;
  by: "human" | "agent";
}

export type RuleKind = "titlePrefix" | "bodySkill" | "labelPair";

export interface Rule {
  id: string;
  kind: RuleKind;
  pattern: string;
  type: WorkTypeName;
  /** 支持它的人类判断条数。一次先例不足以成规则。 */
  support: number;
}

/** 低于这个支持度不参与提议。 */
export const MIN_SUPPORT = 2;

/* ===== 特征抽取 ===== */

const PREFIX_RE = /^\s*(\[[^\]\n]{1,24}\])/;
const SKILL_RE = /skill:([A-Za-z0-9._-]+)/;

function featuresOf(i: Untyped): { kind: RuleKind; pattern: string; evidence: string }[] {
  const out: { kind: RuleKind; pattern: string; evidence: string }[] = [];
  const m = PREFIX_RE.exec(i.title);
  if (m) out.push({ kind: "titlePrefix", pattern: m[1], evidence: `标题前缀 ${m[1]}` });
  const s = SKILL_RE.exec(i.body.slice(0, 400));
  if (s) out.push({ kind: "bodySkill", pattern: s[1], evidence: `由 skill:${s[1]} 产出` });
  return out;
}

/* ===== 提议 ===== */

export interface Proposal {
  type: WorkTypeName | null;
  rule: string | null;
  evidence: string;
  /** 多条规则给出互相冲突的类型——不提议，交给人。 */
  conflict?: boolean;
}

export function proposeType(i: Untyped, rules: Rule[]): Proposal {
  const hits: { r: Rule; evidence: string }[] = [];
  for (const f of featuresOf(i)) {
    for (const r of rules) {
      if (r.support < MIN_SUPPORT) continue;
      if (r.kind === f.kind && r.pattern === f.pattern) hits.push({ r, evidence: f.evidence });
    }
  }
  if (hits.length === 0) return { type: null, rule: null, evidence: "无匹配规则" };
  const types = new Set(hits.map((h) => h.r.type));
  if (types.size > 1) {
    // 冲突不猜。硬选一个会把「系统也拿不准」伪装成「系统知道」。
    return {
      type: null,
      rule: null,
      conflict: true,
      evidence: `规则冲突：${[...types].join(" / ")}`,
    };
  }
  const best = hits.sort((a, b) => b.r.support - a.r.support)[0];
  return { type: best.r.type, rule: best.r.id, evidence: best.evidence };
}

/* ===== 从人类判断学规则 ===== */

export function deriveRules(decisions: Decision[]): Rule[] {
  // 只学人类的。学 agent 自己的提议 = 第一次猜错自我强化。
  const human = decisions.filter((d) => d.by === "human");
  const tally = new Map<string, Map<WorkTypeName, number>>();
  const meta = new Map<string, { kind: RuleKind; pattern: string }>();
  for (const d of human) {
    for (const f of featuresOf(d)) {
      const k = `${f.kind}\u0000${f.pattern}`;
      meta.set(k, { kind: f.kind, pattern: f.pattern });
      const m = tally.get(k) ?? new Map<WorkTypeName, number>();
      m.set(d.type, (m.get(d.type) ?? 0) + 1);
      tally.set(k, m);
    }
  }
  const out: Rule[] = [];
  for (const [k, byType] of tally) {
    // 人自己判得不一致的特征不得成规则。
    if (byType.size !== 1) continue;
    const [type, support] = [...byType][0];
    if (support < MIN_SUPPORT) continue;
    const { kind, pattern } = meta.get(k)!;
    out.push({ id: `${kind}:${pattern}`, kind, pattern, type, support });
  }
  return out.sort((a, b) => b.support - a.support);
}

/* ===== 回放守卫 ===== */

/**
 * 拿**全部**人类判断回放每条规则：会预测错任何一条就拒绝。
 * 这是让「学到的东西」可证伪的那一步——没有它，规则集只是一堆未经检验的猜测。
 */
export function replayGuard(rules: Rule[], decisions: Decision[]): Rule[] {
  const human = decisions.filter((d) => d.by === "human");
  return rules.filter((r) => {
    for (const d of human) {
      const hit = featuresOf(d).some((f) => f.kind === r.kind && f.pattern === r.pattern);
      if (hit && d.type !== r.type) return false; // 反例
    }
    return true;
  });
}

/* ===== 覆盖率：学习有没有真的发生 ===== */

export interface Coverage {
  auto: number;
  total: number;
  ratio: number;
  /** 需要人来断的（含规则冲突的） */
  needsHuman: number;
}

export function coverage(items: Untyped[], rules: Rule[]): Coverage {
  let auto = 0;
  for (const i of items) if (proposeType(i, rules).type) auto++;
  const total = items.length;
  return { auto, total, ratio: total === 0 ? 0 : auto / total, needsHuman: total - auto };
}

/* ===== 批量判断单 ===== */

export interface DecisionGroup {
  /** 共享的特征，如 `skill:epic-conductor` / `前缀 [epic]` */
  feature: string;
  kind: RuleKind;
  pattern: string;
  ids: number[];
  titles: string[];
  /** 已有规则给出的倾向（若有）——只是提示，不是结论 */
  hint: WorkTypeName | null;
  /**
   * 组内有多齐：最常见的标题前缀占比（无前缀算各自不同）。
   *
   * **为什么必须有这个**：`skill:X` 是**出处**信号，不是类型信号。
   * 实测 `skill:epic-conductor` 的 22 条里混着 `[needs-decision]` / `[follow-up]` /
   * `[chore]` / 文档——让人一次给它们定同一个类型，正是「把两件不同的事涂成一件」。
   * 贪心集合覆盖只优化**覆盖量**，不优化**同质度**，所以要单独算并优先排同质的。
   */
  homogeneity: number;
}

/**
 * 把「仍需人断」的项按**共享特征**分组，并用贪心集合覆盖排序：
 * 每一组尽量覆盖最多**尚未被前面组覆盖**的项。
 *
 * 目的是让人做**最少次数**的判断。arc 实测：82 条待判 → 11 次判断覆盖 61 条（74%），
 * 第一次判断就覆盖 22 条。剩下无共享特征的只能逐条看——**不假装它们也能批量**。
 */
export function decisionGroups(items: Untyped[], rules: Rule[], minSize = 2): DecisionGroup[] {
  const byFeature = new Map<string, { kind: RuleKind; pattern: string; ids: Set<number> }>();
  const titleOf = new Map<number, string>();
  for (const i of items) {
    titleOf.set(i.id, i.title);
    for (const f of featuresOf(i)) {
      const k = `${f.kind}\u0000${f.pattern}`;
      const e = byFeature.get(k) ?? { kind: f.kind, pattern: f.pattern, ids: new Set<number>() };
      e.ids.add(i.id);
      byFeature.set(k, e);
    }
  }
  const remaining = new Set(items.map((i) => i.id));
  const out: DecisionGroup[] = [];
  for (;;) {
    let best: { k: string; gain: number } | null = null;
    for (const [k, e] of byFeature) {
      const gain = [...e.ids].filter((x) => remaining.has(x)).length;
      if (gain >= minSize && (!best || gain > best.gain)) best = { k, gain };
    }
    if (!best) break;
    const e = byFeature.get(best.k)!;
    const ids = [...e.ids].filter((x) => remaining.has(x));
    for (const x of ids) remaining.delete(x);
    const hinted = rules.find((r) => r.kind === e.kind && r.pattern === e.pattern);
    // 同质度：组内最常见标题前缀的占比。无前缀的各算一种（互不相同）。
    const prefixes = ids.map((x) => {
      const t = titleOf.get(x) ?? "";
      const mm = PREFIX_RE.exec(t);
      return mm ? mm[1] : `∅${x}`;
    });
    const freq = new Map<string, number>();
    for (const px of prefixes) freq.set(px, (freq.get(px) ?? 0) + 1);
    const homogeneity = ids.length === 0 ? 0 : Math.max(...freq.values()) / ids.length;
    out.push({
      feature: e.kind === "bodySkill" ? `skill:${e.pattern}` : `前缀 ${e.pattern}`,
      kind: e.kind,
      pattern: e.pattern,
      ids,
      titles: ids.map((x) => titleOf.get(x) ?? ""),
      hint: hinted?.type ?? null,
      homogeneity,
    });
    byFeature.delete(best.k);
  }
  // 先按同质度排（≥0.8 视为齐），同档内再按覆盖量。
  // 只按覆盖量排会把「大而杂」顶到最前，而那正是最容易被批错的一组。
  const tier = (h: number) => (h >= 0.8 ? 2 : h >= 0.5 ? 1 : 0);
  return out.sort(
    (a, b) => tier(b.homogeneity) - tier(a.homogeneity) || b.ids.length - a.ids.length,
  );
}

/** 无共享特征、只能逐条看的那些。**不假装它们能批量。** */
export function singletons(items: Untyped[], groups: DecisionGroup[]): number[] {
  const covered = new Set(groups.flatMap((g) => g.ids));
  return items.map((i) => i.id).filter((x) => !covered.has(x));
}
