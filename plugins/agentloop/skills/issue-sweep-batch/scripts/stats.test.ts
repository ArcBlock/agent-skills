import { describe, expect, test } from "bun:test";
import {
  bucketFlow,
  bucketFlowByType,
  bucketsFor,
  severityOf,
  shareSeries,
  stockSeries,
  stockSeriesByType,
  type TimedItem,
  typeTotals,
  untypedShare,
} from "./stats";

const T = (id: number, type: string, created: string, closed?: string): TimedItem => ({
  id,
  type,
  createdAt: created,
  closedAt: closed ?? null,
});

describe("typeTotals", () => {
  const items = [
    T(1, "bug", "2026-08-01"),
    T(2, "bug", "2026-08-02", "2026-08-03"),
    T(3, "feature", "2026-08-01"),
    T(4, "idea", "2026-08-01"),
  ];

  test("open 与 closed 分开计，total 是 open 的总数", () => {
    const r = typeTotals(items);
    expect(r.total).toBe(3); // #2 已关
    expect(r.byType.bug.open).toBe(1);
    expect(r.byType.bug.closed).toBe(1);
    expect(r.byType.feature.open).toBe(1);
  });

  test("★ 没有该类型时给 0，而不是缺键 —— 缺键会让图上少一根柱子而不是显示零", () => {
    const r = typeTotals([T(1, "bug", "2026-08-01")]);
    expect(r.byType.research).toEqual({ open: 0, closed: 0 });
    expect(r.byType.untyped).toEqual({ open: 0, closed: 0 });
  });

  test("未知类型不得静默丢弃", () => {
    const r = typeTotals([T(1, "weird", "2026-08-01")]);
    expect(r.total).toBe(1);
    expect(r.unknownTypes).toEqual(["weird"]);
  });
});

describe("bucketsFor —— 四种粒度", () => {
  const now = new Date("2026-08-30T12:34:00Z");

  test("hour / day / week / month 各自的桶数与跨度", () => {
    expect(bucketsFor("hour", now).length).toBe(24);
    expect(bucketsFor("day", now).length).toBe(14);
    expect(bucketsFor("week", now).length).toBe(12);
    expect(bucketsFor("month", now).length).toBe(30);
  });

  test("桶按时间升序，最后一个包含 now", () => {
    for (const g of ["hour", "day", "week", "month"] as const) {
      const b = bucketsFor(g, now);
      for (let i = 1; i < b.length; i++)
        expect(b[i].start.getTime()).toBeGreaterThan(b[i - 1].start.getTime());
      expect(b[b.length - 1].end.getTime()).toBeGreaterThanOrEqual(now.getTime());
    }
  });
});

describe("bucketFlow —— 开 vs 关（这是回答「为什么总数不降」的那张图）", () => {
  const now = new Date("2026-08-30T12:00:00Z");

  test("ACCEPT：开在开的桶里，关在关的桶里", () => {
    const items = [
      T(1, "bug", "2026-08-29T10:00:00Z", "2026-08-30T10:00:00Z"),
      T(2, "bug", "2026-08-30T09:00:00Z"),
    ];
    const b = bucketsFor("day", now);
    const f = bucketFlow(items, b);
    const last = f[f.length - 1];
    expect(last.opened).toBe(1); // #2 今天开的
    expect(last.closed).toBe(1); // #1 今天关的
    const prev = f[f.length - 2];
    expect(prev.opened).toBe(1); // #1 昨天开的
    expect(prev.closed).toBe(0);
  });

  test("★ 净值 = 开 − 关，正数意味着存量在涨", () => {
    const items = [T(1, "bug", "2026-08-30T09:00:00Z"), T(2, "bug", "2026-08-30T09:30:00Z")];
    const f = bucketFlow(items, bucketsFor("day", now));
    expect(f[f.length - 1].net).toBe(2);
  });

  test("窗口外的项不计入任何桶（不得把 30 天前的开单算进今天）", () => {
    const f = bucketFlow([T(1, "bug", "2020-01-01T00:00:00Z")], bucketsFor("day", now));
    expect(f.every((x) => x.opened === 0)).toBe(true);
  });

  test("★ 空输入返回**全零的桶**，不是空数组 —— 空数组会让图整块消失", () => {
    const f = bucketFlow([], bucketsFor("day", now));
    expect(f.length).toBe(14);
    expect(f.every((x) => x.opened === 0 && x.closed === 0)).toBe(true);
  });
});

describe("stockSeries —— 存量随时间（burn-down 的那条线）", () => {
  const now = new Date("2026-08-30T12:00:00Z");

  test("ACCEPT：每个桶末的存量 = 当时还开着的数量", () => {
    const items = [
      T(1, "bug", "2026-08-28T00:00:00Z"), // 一直开着
      T(2, "bug", "2026-08-28T00:00:00Z", "2026-08-29T12:00:00Z"), // 29 号关
    ];
    const b = bucketsFor("day", now);
    const s = stockSeries(items, b);
    const at28 = s[b.findIndex((x) => x.label.endsWith("08-28"))];
    const at30 = s[s.length - 1];
    expect(at28.open).toBe(2);
    expect(at30.open).toBe(1);
  });

  test("★ 关闭早于创建的脏数据按「已关」处理 —— 每个桶都必须是 0", () => {
    // 断言具体值，不是 `>= 0`：脏数据让计数**变高**而不是变负，
    // `>= 0` 对两种结果同色（变异测试照出来的第三个弱断言）。
    const bad = [T(1, "bug", "2026-08-30T00:00:00Z", "2026-08-01T00:00:00Z")];
    const s = stockSeries(bad, bucketsFor("day", now));
    expect(s.map((x) => x.open)).toEqual(s.map(() => 0));
  });

  test("干净数据仍然计入（上一条的 accept 臂：别把「一律不计」当成修好了）", () => {
    const ok = [T(1, "bug", "2026-08-28T00:00:00Z")];
    const s = stockSeries(ok, bucketsFor("day", now));
    expect(s[s.length - 1].open).toBe(1);
  });

  test("空输入 → 全零序列，长度与桶一致", () => {
    const b = bucketsFor("week", now);
    const s = stockSeries([], b);
    expect(s.length).toBe(b.length);
    expect(s.every((x) => x.open === 0)).toBe(true);
  });
});

describe("untyped 是健康信号，不只是一个计数", () => {
  const now = new Date("2026-08-30T12:00:00Z");

  test("★ severityOf 的阈值：>=25% 红，>=10% 黄，否则正常", () => {
    expect(severityOf(0.32)).toBe("bad");
    expect(severityOf(0.25)).toBe("bad");
    expect(severityOf(0.24)).toBe("warn");
    expect(severityOf(0.1)).toBe("warn");
    expect(severityOf(0.09)).toBe("ok");
    expect(severityOf(0)).toBe("ok");
  });

  test("★ 0 个工作项时不得报红（除以零不能变成「全是 untyped」）", () => {
    expect(untypedShare([]).ratio).toBe(0);
    expect(severityOf(untypedShare([]).ratio)).toBe("ok");
  });

  test("untypedShare 只算 open 的（已关的不再需要分类）", () => {
    const items = [
      T(1, "untyped", "2026-08-01"),
      T(2, "untyped", "2026-08-01", "2026-08-02"),
      T(3, "bug", "2026-08-01"),
    ];
    const r = untypedShare(items);
    expect(r.untyped).toBe(1);
    expect(r.total).toBe(2);
    expect(r.ratio).toBeCloseTo(0.5);
  });

  test("★ 占比趋势：涨还是降才是真信号，不是当下那个数", () => {
    // 时间刻意避开桶边界：桶 [08-28, 08-29) 的「末态」测的是 08-29T00:00 那一刻，
    // 创建时间正好等于它的项**会被算进去**（与 stockSeries 行为一致）。
    // 第一版 fixture 卡在这个刀刃上，测的是边界语义而不是趋势。
    const items = [
      T(1, "bug", "2026-08-28T00:00:00Z"),
      T(2, "untyped", "2026-08-29T06:00:00Z"),
      T(3, "untyped", "2026-08-29T06:00:00Z"),
      T(4, "untyped", "2026-08-29T06:00:00Z"),
    ];
    const b = bucketsFor("day", now);
    const s = shareSeries(items, b, "untyped");
    const i28 = b.findIndex((x) => x.label.endsWith("08-28"));
    expect(s[i28]).toBeCloseTo(0);
    expect(s[s.length - 1]).toBeCloseTo(0.75);
  });

  test("★ 某个桶里一个 open 都没有时占比是 0，不是 NaN（NaN 会让线断掉）", () => {
    const s = shareSeries([], bucketsFor("day", now), "untyped");
    expect(s.every((x) => x === 0)).toBe(true);
    expect(s.every((x) => Number.isFinite(x))).toBe(true);
  });
});

describe("★ 按类型分解的序列 —— 一根「全部」的柱子看不出进的是什么、出的是什么", () => {
  const now = new Date("2026-08-30T12:00:00Z");
  const d = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  const items = [
    { id: 1, type: "bug", createdAt: d(1), closedAt: null },
    { id: 2, type: "bug", createdAt: d(2), closedAt: d(1) },
    { id: 3, type: "feature", createdAt: d(1), closedAt: null },
    { id: 4, type: "feature", createdAt: d(3), closedAt: null },
    { id: 5, type: "idea", createdAt: d(2), closedAt: d(2) },
    // 未知类型：**不能从堆叠里消失**，否则堆起来的高度小于总量而没人看得出来
    { id: 6, type: "chore", createdAt: d(1), closedAt: null },
  ];
  const b = bucketsFor("day", now);

  test("★ 逐桶：各类型之和必须等于总量（堆叠图的高度不能少一截）", () => {
    const agg = bucketFlow(items, b);
    const byType = bucketFlowByType(items, b);
    for (let i = 0; i < b.length; i++) {
      let o = 0;
      let c = 0;
      for (const t of Object.keys(byType)) {
        o += byType[t][i].opened;
        c += byType[t][i].closed;
      }
      expect(o).toBe(agg[i].opened);
      expect(c).toBe(agg[i].closed);
    }
  });

  test("★ 未知类型自成一层，不被静默丢弃", () => {
    expect(Object.keys(bucketFlowByType(items, b))).toContain("chore");
  });

  test("★ 存量同理：各类型之和 == 总存量", () => {
    const agg = stockSeries(items, b);
    const byType = stockSeriesByType(items, b);
    for (let i = 0; i < b.length; i++) {
      const sum = Object.keys(byType).reduce((a, t) => a + byType[t][i].open, 0);
      expect(sum).toBe(agg[i].open);
    }
  });

  test("ACCEPT：空输入 → 每个类型都是全零桶而不是空数组", () => {
    const empty = bucketFlowByType([], b);
    expect(Object.keys(empty).length).toBe(0);
    // 有一条就得有一整条全零的桶序列，长度与 buckets 对齐
    const one = bucketFlowByType([items[0]], b);
    expect(one.bug.length).toBe(b.length);
  });
});
