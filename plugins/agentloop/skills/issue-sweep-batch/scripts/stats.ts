/**
 * 存量与流量统计 —— 概览页的可判定核心。
 *
 * 两张图回答两个不同的问题，别混为一谈：
 *
 *   **流量（opened vs closed per bucket）** —— 进货和出货哪个快？
 *     这是「修了这么多为什么总数不降」的直接答案。实测：某 14 天窗口
 *     开 770 / 关 612，净 +158——关闭吞吐并不低，是进货更快。
 *
 *   **存量（open count at each bucket end）** —— 常说的 burn-down 那条线。
 *     它是流量的积分，好看但**滞后**：净值转负好几天后存量线才明显下弯。
 *     所以两张都要有，先看流量再看存量。
 *
 * 要画这两张图必须同时拿到**已关闭**的项（`closedAt`）。GitHub 下这是额外一次
 * 昂贵拉取；work object 下是一次带时间范围的查询。这也是 work object 的具体优势之一。
 */

export interface TimedItem {
  id: number;
  type: string;
  createdAt: string;
  closedAt: string | null;
}

export const KNOWN_TYPES = ["bug", "feature", "idea", "research", "report", "untyped"] as const;
export type KnownType = (typeof KNOWN_TYPES)[number];

export interface Totals {
  /** 当前还开着的总数 */
  total: number;
  byType: Record<string, { open: number; closed: number }>;
  /** 出现过但不在 KNOWN_TYPES 里的类型——**不静默丢弃**，让它可见 */
  unknownTypes: string[];
}

export function typeTotals(items: TimedItem[]): Totals {
  const byType: Record<string, { open: number; closed: number }> = {};
  // 预置全部已知类型：缺键会让图上少一根柱子，而不是显示一根零高的柱子。
  for (const t of KNOWN_TYPES) byType[t] = { open: 0, closed: 0 };
  const unknown = new Set<string>();
  let total = 0;
  for (const i of items) {
    if (!(KNOWN_TYPES as readonly string[]).includes(i.type)) unknown.add(i.type);
    byType[i.type] ??= { open: 0, closed: 0 };
    if (i.closedAt) byType[i.type].closed++;
    else {
      byType[i.type].open++;
      total++;
    }
  }
  return { total, byType, unknownTypes: [...unknown].sort() };
}

/* ===== 分桶 ===== */

export type Granularity = "hour" | "day" | "week" | "month";

export interface Bucket {
  start: Date;
  end: Date;
  label: string;
}

const SPAN: Record<Granularity, { ms: number; n: number }> = {
  hour: { ms: 3_600_000, n: 24 },
  day: { ms: 86_400_000, n: 14 },
  week: { ms: 7 * 86_400_000, n: 12 },
  month: { ms: 86_400_000, n: 30 }, // 「最近 30 天」按天分桶，不是按月
};

function label(g: Granularity, d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  if (g === "hour") return `${p(d.getUTCHours())}:00`;
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export function bucketsFor(g: Granularity, now: Date): Bucket[] {
  const { ms, n } = SPAN[g];
  const endAligned = Math.floor(now.getTime() / ms) * ms + ms;
  const out: Bucket[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = new Date(endAligned - (i + 1) * ms);
    out.push({ start, end: new Date(start.getTime() + ms), label: label(g, start) });
  }
  return out;
}

/* ===== 流量 ===== */

export interface FlowPoint {
  label: string;
  opened: number;
  closed: number;
  net: number;
}

export function bucketFlow(items: TimedItem[], buckets: Bucket[]): FlowPoint[] {
  // 从全零桶起步：空输入必须返回**全零的桶**而不是空数组，
  // 空数组会让整块图消失，而「没有数据」与「没有活动」是两回事。
  const out: FlowPoint[] = buckets.map((b) => ({ label: b.label, opened: 0, closed: 0, net: 0 }));
  const idx = (t: number) =>
    buckets.findIndex((b) => t >= b.start.getTime() && t < b.end.getTime());
  for (const i of items) {
    const c = idx(new Date(i.createdAt).getTime());
    if (c >= 0) out[c].opened++;
    if (i.closedAt) {
      const z = idx(new Date(i.closedAt).getTime());
      if (z >= 0) out[z].closed++;
    }
  }
  for (const p of out) p.net = p.opened - p.closed;
  return out;
}

/* ===== 存量 ===== */

export interface StockPoint {
  label: string;
  open: number;
}

export function stockSeries(items: TimedItem[], buckets: Bucket[]): StockPoint[] {
  return buckets.map((b) => {
    const at = b.end.getTime();
    let n = 0;
    for (const i of items) {
      const created = new Date(i.createdAt).getTime();
      if (created > at) continue;
      const closed = i.closedAt ? new Date(i.closedAt).getTime() : Number.POSITIVE_INFINITY;
      // closed < created 是脏数据（时钟/导入）。按「已关」处理，绝不让存量变负。
      if (closed <= at) continue;
      n++;
    }
    return { label: b.label, open: Math.max(0, n) };
  });
}

/* ===== untyped 作为健康信号 ===== */

export interface Share {
  untyped: number;
  total: number;
  ratio: number;
}

/** 只算 open 的：已关的不再需要分类。 */
export function untypedShare(items: TimedItem[]): Share {
  let untyped = 0;
  let total = 0;
  for (const i of items) {
    if (i.closedAt) continue;
    total++;
    if (i.type === "untyped") untyped++;
  }
  return { untyped, total, ratio: total === 0 ? 0 : untyped / total };
}

export type Severity = "ok" | "warn" | "bad";

/** 门槛与 health.ts 的 `T` 保持一致：>=25% 红，>=10% 黄。 */
export function severityOf(ratio: number): Severity {
  return ratio >= 0.25 ? "bad" : ratio >= 0.1 ? "warn" : "ok";
}

/**
 * 某个类型占 open 的比例随时间 —— **涨还是降才是真信号，不是当下那个数**。
 * 某个桶里一个 open 都没有时返回 0，不是 NaN（NaN 会让线断掉）。
 */
export function shareSeries(items: TimedItem[], buckets: Bucket[], type: string): number[] {
  return buckets.map((b) => {
    const at = b.end.getTime();
    let hit = 0;
    let open = 0;
    for (const i of items) {
      const created = new Date(i.createdAt).getTime();
      if (created > at) continue;
      const closed = i.closedAt ? new Date(i.closedAt).getTime() : Number.POSITIVE_INFINITY;
      if (closed <= at) continue;
      open++;
      if (i.type === type) hit++;
    }
    return open === 0 ? 0 : hit / open;
  });
}
