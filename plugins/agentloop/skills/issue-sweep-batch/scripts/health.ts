/**
 * 工厂健康 —— 从「issue 记账」变成「值班厂长」。
 *
 * 目标不是给人更多数据，而是让人 **5 秒钟知道需不需要管**。
 *
 * ## 分两层，第一层不是 LLM
 *
 *   1. **硬 detector**（本文件）：确定性、便宜、可测。每条给出证据，不给结论。
 *   2. **健康判读**：把 detector 的输出合成一个状态 + 至多三条解释。
 *
 * agent 应当读**结构化输出**，不是截图。渲染 → 视觉理解 → 推理这条链会再加一层
 * 不必要的噪声，而我们已经在验证信号上吃过噪声的亏。
 *
 * ## 每个 detector 必须有 accept 臂
 *
 * **一个从不触发的 detector 与一个健康的工厂完全同色。** 所以：
 *
 * - `detectors()` 在健康基线上必须返回**空数组**（测试里钉死了这条）
 * - `assess()` 必须**能说 healthy 且 humanAttention=false**
 *
 * 只会说黄/红的系统等于没有系统——它会退化成另一个骚扰人的 micro-manager。
 *
 * ## 单信号不足以判定
 *
 * `backlog-expansion` 要求**进出比高**且**存量在涨**两个条件同时成立。
 * 只看比值会在「正在恢复」时误报——今天 arc 的实况正是比值仍高但存量开始降。
 */

export interface HealthItem {
  id: number;
  type: string;
  createdAt: string;
  closedAt: string | null;
}

export interface HealthInput {
  now: Date;
  items: HealthItem[];
  /**
   * 最近 7 个桶的**相对存量**曲线，应由 `netToCumulative(每日净值)` 产出。
   * **不要**直接传 stockSeries——它的左端受关闭窗口影响而系统性偏低。
   */
  stock7d: number[];
  untyped?: number;
  total?: number;
  /**
   * 按仓库覆盖门槛。**插件出机制与默认值，具体数字住消费仓库的 profile**——
   * `T` 里的 symptom TTL 是从 arc 自己的 test-sweep 历史标出来的，直接发给每个
   * 消费仓库会让诊断节奏更慢的仓库天天收到 action-required（插件 CLAUDE.md 第一原则）。
   * 只覆盖给到的那几项，其余仍用默认。
   */
  thresholds?: Partial<Thresholds>;
}

export interface Signal {
  id: string;
  severity: "warn" | "bad";
  title: string;
  /** 可复核的事实，不是结论 */
  evidence: string;
}

/* ===== 基础量 ===== */

export interface Flow {
  created: number;
  closed: number;
  /** created / max(closed, 1) —— 不用 Infinity，那会让判据整块失效 */
  ratio: number;
}

export function flowRatio(i: Pick<HealthInput, "now" | "items">, days = 7): Flow {
  const since = i.now.getTime() - days * 86_400_000;
  let created = 0;
  let closed = 0;
  for (const x of i.items) {
    if (new Date(x.createdAt).getTime() >= since) created++;
    if (x.closedAt && new Date(x.closedAt).getTime() >= since) closed++;
  }
  return { created, closed, ratio: created === 0 ? 0 : created / Math.max(closed, 1) };
}

/** 最小二乘斜率。空/单点序列返回 0。 */
export function backlogSlope(series: number[]): number {
  const n = series.length;
  if (n < 2) return 0;
  const mx = (n - 1) / 2;
  const my = series.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (series[i] - my);
    den += (i - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/**
 * 把每桶净值（开 − 关）累加成一条**无偏**的相对存量曲线。
 *
 * **为什么不直接用 stock 序列**：stock 由「当前 open + 窗口内已关闭」推出，
 * 而已关闭项只取最近 N 天——更早关闭的项不在窗口内，导致曲线**左端系统性偏低**，
 * 于是斜率被这个测量伪影抬高。实测把 stock 喂进 detector 得到 +16.4/天，
 * 而同期净值其实在转负。
 *
 * 净值来自同一个窗口的开与关，两边偏差同源，作差后抵消。
 */
export function netToCumulative(net: number[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const n of net) {
    acc += n;
    out.push(acc);
  }
  return out;
}

/**
 * 年龄刻度 —— **唯一一张表**，别处（桶名、归属、陈货门槛、页面上的顺序）都从它派生。
 *
 * 加一档时最容易漏的是陈货判据：detector 里手写 `ages["7-14d"] + ages[">14d"]` 的话，
 * 新加的 `30-90d` / `>90d` 会**悄悄不算进陈货**，于是「陈货变少了」与「新档没接线」
 * 完全同色。所以 `STALE_BUCKETS` 也从这张表算，不手写。
 *
 * 为什么切到 30 / 90：14 天以上曾经是一个桶，而 arc 上它一个人就占 open 的 40%——
 * 一个装了 40% 的桶不区分「两周」和「半年」，等于没有分档。
 */
export const AGE_SCALE = [
  { key: "<1d", from: 0 },
  { key: "1-3d", from: 1 },
  { key: "3-7d", from: 3 },
  { key: "7-14d", from: 7 },
  { key: "14-30d", from: 14 },
  { key: "30-90d", from: 30 },
  { key: ">90d", from: 90 },
] as const;

export const AGE_BUCKETS = AGE_SCALE.map((x) => x.key) as readonly AgeBucket[];
export type AgeBucket = (typeof AGE_SCALE)[number]["key"];

/** 超过这个天数算「陈货」。档位边界必须与它对齐，否则这条线会落在某一档中间。 */
export const STALE_FROM_DAYS = 7;

/** 计入陈货的档 —— 从表里算，不手写。 */
export const STALE_BUCKETS = AGE_SCALE.filter((x) => x.from >= STALE_FROM_DAYS).map(
  (x) => x.key,
) as AgeBucket[];

/**
 * 年龄 → 桶。**唯一实现**（左闭右开）。
 *
 * 页面上的年龄柱是可点的：点一个桶就按它过滤 issue 列表。若柱子的计数与过滤器
 * 各自实现一遍边界，两边会悄悄漂移——**「柱子说 108」与「点开给出 97」在页面上
 * 完全同色**，而没有人会去数。所以桶的归属只算一次，序列化进每条 item，
 * 前端只做字符串相等（`html.ts` 的 `ageBucket`）。
 */
export function ageBucketOf(days: number): AgeBucket {
  // 从最老一档往回找：加档时只改 AGE_SCALE，这个函数不用动。
  for (let i = AGE_SCALE.length - 1; i > 0; i--)
    if (days >= AGE_SCALE[i].from) return AGE_SCALE[i].key;
  return AGE_SCALE[0].key;
}

export function agingBuckets(items: HealthItem[], now: Date): Record<AgeBucket, number> {
  // 预置五个桶：缺桶会让图少一根柱子，而不是显示一根零高的柱子。
  const out = Object.fromEntries(AGE_BUCKETS.map((b) => [b, 0])) as Record<AgeBucket, number>;
  for (const i of items) {
    if (i.closedAt) continue;
    out[ageBucketOf((now.getTime() - new Date(i.createdAt).getTime()) / 86_400_000)]++;
  }
  return out;
}

/* ===== 门槛（集中放，便于审阅与调参） ===== */

/**
 * 默认门槛。**这些数字是 arc 的标定**，随插件发出去只是默认值——消费仓库通过
 * `HealthInput.thresholds` 覆盖（值住它自己的 `.claude/repo-profile.md`）。
 */
/**
 * 门槛的**类型**是通用的（都是 number），值才是每个仓库自己的。
 *
 * 不写这个接口、直接 `Partial<typeof DEFAULT_T>` 的话，`as const` 会把字段钉成
 * **字面量类型**（`symptomTtlDays: 7`），于是「按仓库覆盖」这个能力在类型上根本不存在
 * ——`{ symptomTtlDays: 30 }` 通不过 tsc。单测发现不了它（bun test 不做类型检查），
 * 是跨引擎 review 抓到的。
 */
export interface Thresholds {
  flowRatio: number;
  slope: number;
  untypedWarn: number;
  untypedBad: number;
  staleWarn: number;
  /**
   * **未配置就不跑这个 detector。** 拿 arc 的标定去警告别的仓库，等于用别人的节奏
   * 判它有病。默认表里给了值是给 arc 用的；消费仓库没在 profile 里配之前，
   * 宁可没有这个信号，也不要一个假的。
   */
  symptomTtlDays: number;
  symptomOverdueMin: number;
  symptomOverdueBadRatio: number;
}

export const DEFAULT_T: Thresholds = {
  /** 进出比：进货超过出货这么多倍才算异常 */
  flowRatio: 1.25,
  /** 存量斜率：每桶净增超过这个数才算在涨 */
  slope: 1,
  /** untyped 占比 */
  untypedWarn: 0.15,
  untypedBad: 0.25,
  /** >7d 陈货占 open 的比例 */
  staleWarn: 0.4,
  /**
   * symptom 的诊断 TTL（天）。
   *
   * **标定自实测，不是拍的**：arc 上已判决关闭的 test-sweep-failure，全部在
   * **0–5 天**内关闭（抽样 20 条，最长 4365 的 5 天，中位约 2 天）。7 天因此落在
   * 观测分布之外——超过它的那条，是相对这个工厂**自己的**基线的偏离，
   * 不是一个从外面拍下来的数字。
   *
   * 这条也是「基线偏离优于固定阈值」（oversight-discipline）在本 detector 上的落点。
   */
  symptomTtlDays: 7,
  /** 超期几条才叫。1 条不叫——可能只是刚好跨过，那种噪声会把这个 detector 变成常亮。 */
  symptomOverdueMin: 2,
  /** 超期占 open symptom 的比例到这个数，说明积压的是判决本身，不是个别条目 */
  symptomOverdueBadRatio: 0.5,
};

/** 向后兼容的默认表别名 —— 直接读 `T.x` 的调用方拿到的是默认值。 */
export const T = DEFAULT_T;

/* ===== detector ===== */

export function detectors(i: HealthInput): Signal[] {
  const T = { ...DEFAULT_T, ...(i.thresholds ?? {}) };
  const out: Signal[] = [];
  const f = flowRatio(i);
  const slope = backlogSlope(i.stock7d);

  // 两个条件同时成立才报。只看比值会在「正在恢复」时误报。
  if (f.ratio > T.flowRatio && slope > T.slope) {
    out.push({
      id: "backlog-expansion",
      severity: "warn",
      title: "存量在扩张",
      evidence: `7 天新建 ${f.created} / 关闭 ${f.closed}（比值 ${f.ratio.toFixed(2)}），存量斜率 +${slope.toFixed(1)}/桶`,
    });
  }

  const total = i.total ?? i.items.filter((x) => !x.closedAt).length;
  const untyped = i.untyped ?? 0;
  const ur = total === 0 ? 0 : untyped / total;
  if (ur >= T.untypedWarn) {
    out.push({
      id: "classification-debt",
      severity: ur >= T.untypedBad ? "bad" : "warn",
      title: "分类欠账",
      evidence: `${untyped}/${total}（${(ur * 100).toFixed(0)}%）没有类型 —— 分类决定 routing / priority / verification / repair policy`,
    });
  }

  // symptom = 走查报出的、尚未给出判决的观察。判成 bug 会改类型离开本桶，
  // 其余判决（test-defect / env / stale / normal）一律关闭（classify.ts 的
  // SYMPTOM_VERDICTS 钉住了这条）。所以「仍然 open 且超期」= 还没有人判决。
  //
  // 为什么必须单独有这个 detector：symptom 停在桶里不动时，「诊断完发现不是缺陷」
  // 与「根本没人看」在存量上完全同色。stale-work 看不出它——那条看的是笼统的年龄，
  // 一条 20 天的 feature 和一条 8 天未判决的 symptom 在它眼里一样。
  // 门槛没被显式配置时，这个 detector 整个不跑（见 Thresholds.symptomTtlDays）。
  const symptomTtl = i.thresholds?.symptomTtlDays;
  const openSymptoms =
    symptomTtl === undefined ? [] : i.items.filter((x) => !x.closedAt && x.type === "symptom");
  const overdue = openSymptoms.filter(
    (x) => (i.now.getTime() - new Date(x.createdAt).getTime()) / 86_400_000 > T.symptomTtlDays,
  );
  if (overdue.length >= T.symptomOverdueMin) {
    const r = overdue.length / openSymptoms.length;
    out.push({
      id: "undiagnosed-symptom",
      severity: r >= T.symptomOverdueBadRatio ? "bad" : "warn",
      title: "症状未判决",
      // 证据只说**这个仓库这一轮**测到的事实。写死「实测诊断周期 0–5 天」是 arc 的
      // 标定，别的仓库覆盖了 TTL 之后那句话就是假的（跨引擎 review 抓到的）。
      // 标定的来历住消费仓库的 profile（`symptom_ttl_days`），不住证据文案。
      evidence: `${overdue.length}/${openSymptoms.length} 条 symptom 开着超过 ${symptomTtl} 天仍无判决（#${overdue
        .map((x) => x.id)
        .join(" #")}）—— 判决未做出，不是「审过了没事」`,
    });
  }

  const ages = agingBuckets(i.items, i.now);
  const open = Object.values(ages).reduce((a, b) => a + b, 0);
  // 从 STALE_BUCKETS 求和，不手写档名——手写的话新加的档会悄悄不计入。
  const stale = STALE_BUCKETS.reduce((n, b) => n + ages[b], 0);
  if (open > 0 && stale / open >= T.staleWarn) {
    out.push({
      id: "stale-work",
      severity: "warn",
      title: "陈货堆积",
      evidence: `${stale}/${open}（${((stale / open) * 100).toFixed(0)}%）已开着超过 ${STALE_FROM_DAYS} 天 —— 总量不重要，年龄重要`,
    });
  }

  return out;
}

/* ===== 健康判读 ===== */

/** 至多给人看几条解释。不做 alert spam。 */
export const MAX_EXPLANATIONS = 3;

/**
 * 上限本身抽成一个可直接测的单元。
 *
 * **为什么不内联**：当前只有 3 个 detector，`slice(0, 3)` 天然不可达，
 * 把它写在 `assess()` 里的话，删掉它测试照样全绿——变异测试实测存活过。
 * 「防御性代码」与「没有这段代码」在测试上同色，除非它能被单独调用。
 */
export function capExplanations(list: string[], max = MAX_EXPLANATIONS): string[] {
  return list.slice(0, max);
}

export interface Assessment {
  status: "healthy" | "degraded" | "action-required";
  /** 是否需要人介入。**「不需要」必须是常见输出。** */
  humanAttention: boolean;
  headline: string;
  /** 至多三条。不做 alert spam。 */
  explanations: string[];
  signals: Signal[];
}

export function assess(i: HealthInput): Assessment {
  const signals = detectors(i);
  const slope = backlogSlope(i.stock7d);
  const f = flowRatio(i);
  const recovering = slope < 0;

  if (signals.length === 0) {
    return {
      status: "healthy",
      humanAttention: false,
      headline: "工厂产出正常，**不需要**人介入。",
      explanations: [
        `7 天新建 ${f.created} / 关闭 ${f.closed}`,
        recovering ? `存量在下降（斜率 ${slope.toFixed(1)}/桶）` : "存量平稳",
      ],
      signals,
    };
  }

  const bad = signals.filter((s) => s.severity === "bad");
  const status = bad.length > 0 ? "action-required" : "degraded";
  const ordered = [...bad, ...signals.filter((s) => s.severity === "warn")];
  const explanations = capExplanations(ordered.map((s) => `${s.title}：${s.evidence}`));

  // 恢复中要被说出来。只报「存量高」会让人误以为在恶化。
  if (recovering && explanations.length < MAX_EXPLANATIONS) {
    explanations.push(`但存量正在**下降**（斜率 ${slope.toFixed(1)}/桶）—— 若持续则无需处置`);
  }

  return {
    status,
    // 只有 bad 才叫人。warn 是「看着」，不是「来处理」。
    humanAttention: bad.length > 0,
    headline:
      status === "action-required"
        ? `需要人判断：${bad[0].title}`
        : `有信号但不需要人介入：${ordered[0].title}`,
    explanations,
    signals,
  };
}
