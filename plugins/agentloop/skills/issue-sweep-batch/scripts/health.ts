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

export const AGE_BUCKETS = ["<1d", "1-3d", "3-7d", "7-14d", ">14d"] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

export function agingBuckets(items: HealthItem[], now: Date): Record<AgeBucket, number> {
  // 预置五个桶：缺桶会让图少一根柱子，而不是显示一根零高的柱子。
  const out = Object.fromEntries(AGE_BUCKETS.map((b) => [b, 0])) as Record<AgeBucket, number>;
  for (const i of items) {
    if (i.closedAt) continue;
    const d = (now.getTime() - new Date(i.createdAt).getTime()) / 86_400_000;
    const b: AgeBucket =
      d < 1 ? "<1d" : d < 3 ? "1-3d" : d < 7 ? "3-7d" : d < 14 ? "7-14d" : ">14d";
    out[b]++;
  }
  return out;
}

/* ===== 门槛（集中放，便于审阅与调参） ===== */

export const T = {
  /** 进出比：进货超过出货这么多倍才算异常 */
  flowRatio: 1.25,
  /** 存量斜率：每桶净增超过这个数才算在涨 */
  slope: 1,
  /** untyped 占比 */
  untypedWarn: 0.15,
  untypedBad: 0.25,
  /** >7d 陈货占 open 的比例 */
  staleWarn: 0.4,
} as const;

/* ===== detector ===== */

export function detectors(i: HealthInput): Signal[] {
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

  const ages = agingBuckets(i.items, i.now);
  const open = Object.values(ages).reduce((a, b) => a + b, 0);
  const stale = ages["7-14d"] + ages[">14d"];
  if (open > 0 && stale / open >= T.staleWarn) {
    out.push({
      id: "stale-work",
      severity: "warn",
      title: "陈货堆积",
      evidence: `${stale}/${open}（${((stale / open) * 100).toFixed(0)}%）已开着超过 7 天 —— 总量不重要，年龄重要`,
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
