import { describe, expect, test } from "bun:test";
import {
  agingBuckets,
  assess,
  backlogSlope,
  capExplanations,
  detectors,
  flowRatio,
  type HealthInput,
  MAX_EXPLANATIONS,
  netToCumulative,
} from "./health";

const now = new Date("2026-08-30T12:00:00Z");
const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

/**
 * 一个**真的**健康的基线：7 天窗口内进出平衡、分类清楚、没有陈货、存量平稳。
 * 第一版这里是 4 开 2 关（比值 2），detector 没触发只是因为斜率平——
 * 那样的基线通不过「全维度健康」的检验，是 fixture 的问题不是代码的问题。
 */
const healthy: HealthInput = {
  now,
  items: [
    { id: 1, type: "bug", createdAt: day(1), closedAt: null },
    { id: 2, type: "feature", createdAt: day(2), closedAt: null },
    { id: 3, type: "bug", createdAt: day(3), closedAt: day(1) },
    { id: 4, type: "bug", createdAt: day(4), closedAt: day(2) },
    // 再关两条更早开的：窗口内 created 4 / closed 4，比值 1
    { id: 5, type: "bug", createdAt: day(10), closedAt: day(2) },
    { id: 6, type: "bug", createdAt: day(11), closedAt: day(3) },
  ],
  stock7d: [10, 10, 9, 10, 9, 10, 9],
};

describe("flowRatio / backlogSlope", () => {
  test("进出平衡 → 比值约 1，斜率约 0", () => {
    const f = flowRatio(healthy);
    expect(f.created).toBeGreaterThan(0);
    expect(f.ratio).toBeLessThan(1.25);
    expect(Math.abs(backlogSlope(healthy.stock7d))).toBeLessThan(1);
  });

  test("★ 没有关闭时比值不得是 Infinity（会让判据整块失效）", () => {
    const f = flowRatio({
      ...healthy,
      items: [{ id: 1, type: "bug", createdAt: day(1), closedAt: null }],
    });
    expect(Number.isFinite(f.ratio)).toBe(true);
  });

  test("空输入 → 比值 0、斜率 0，不抛不 NaN", () => {
    const f = flowRatio({ now, items: [], stock7d: [] });
    expect(f.ratio).toBe(0);
    expect(backlogSlope([])).toBe(0);
  });

  test("存量单调上升 → 斜率为正；下降 → 为负", () => {
    expect(backlogSlope([10, 20, 30, 40])).toBeGreaterThan(0);
    expect(backlogSlope([40, 30, 20, 10])).toBeLessThan(0);
  });
});

describe("agingBuckets —— 总量不重要，年龄重要", () => {
  test("按年龄分桶，只算还开着的", () => {
    const b = agingBuckets(healthy.items, now);
    expect(b["<1d"] + b["1-3d"] + b["3-7d"] + b["7-14d"] + b[">14d"]).toBe(2);
    expect(b[">14d"]).toBe(0); // 基线里没有陈货
  });

  test("★ 空输入返回全零的**五个**桶，不是空对象（缺桶会让图少一根柱子）", () => {
    const b = agingBuckets([], now);
    expect(Object.keys(b).length).toBe(5);
    expect(Object.values(b).every((v) => v === 0)).toBe(true);
  });

  test("陈货落进 >14d", () => {
    const b = agingBuckets([{ id: 1, type: "bug", createdAt: day(30), closedAt: null }], now);
    expect(b[">14d"]).toBe(1);
  });
});

describe("★ detectors —— 每个都要有 accept 臂", () => {
  test("★ ACCEPT：健康基线上**一个 detector 都不触发**", () => {
    // 这是全套 detector 的 accept 臂。缺了它，「全都触发」与「正确」同色。
    const fired = detectors({ ...healthy, untyped: 0, total: 4 });
    expect(fired).toEqual([]);
  });

  test("REJECT：进货是出货的 1.25 倍以上 且 存量在涨 → backlog detector 触发", () => {
    const bad: HealthInput = {
      now,
      untyped: 0,
      total: 10,
      stock7d: [10, 20, 30, 40, 50, 60, 70],
      items: [
        ...Array.from({ length: 9 }, (_, i) => ({
          id: i,
          type: "bug",
          createdAt: day(1),
          closedAt: null,
        })),
        { id: 99, type: "bug", createdAt: day(5), closedAt: day(1) },
      ],
    };
    expect(detectors(bad).map((d) => d.id)).toContain("backlog-expansion");
  });

  test("★ REJECT：单看比值不够 —— 比值高但存量在降，不得触发", () => {
    // 只看一个信号会在「正在恢复」时误报。两个条件必须同时成立。
    const recovering: HealthInput = {
      now,
      untyped: 0,
      total: 10,
      stock7d: [70, 60, 50, 40, 30, 20, 10],
      items: [
        ...Array.from({ length: 9 }, (_, i) => ({
          id: i,
          type: "bug",
          createdAt: day(1),
          closedAt: null,
        })),
        { id: 99, type: "bug", createdAt: day(5), closedAt: day(1) },
      ],
    };
    expect(recovering.stock7d && backlogSlope(recovering.stock7d)).toBeLessThan(0);
    expect(detectors(recovering).map((d) => d.id)).not.toContain("backlog-expansion");
  });

  test("REJECT：untyped 超过 15% → classification-debt 触发", () => {
    const d = detectors({ ...healthy, untyped: 32, total: 100 });
    expect(d.map((x) => x.id)).toContain("classification-debt");
  });

  test("ACCEPT：untyped 低于门槛不触发", () => {
    expect(detectors({ ...healthy, untyped: 10, total: 100 }).map((x) => x.id)).not.toContain(
      "classification-debt",
    );
  });

  test("REJECT：>7d 的陈货占比过高 → stale-work 触发", () => {
    const stale: HealthInput = {
      now,
      untyped: 0,
      total: 4,
      stock7d: [10, 10, 10, 10, 10, 10, 10],
      items: Array.from({ length: 4 }, (_, i) => ({
        id: i,
        type: "bug",
        createdAt: day(20),
        closedAt: null,
      })),
    };
    expect(detectors(stale).map((d) => d.id)).toContain("stale-work");
  });

  test("★ 每个 detector 都必须带可复核的证据，不能只给一个结论", () => {
    for (const d of detectors({ ...healthy, untyped: 50, total: 100 })) {
      expect(d.evidence.length).toBeGreaterThan(0);
      expect(d.severity === "warn" || d.severity === "bad").toBe(true);
    }
  });
});

describe("★ assess —— 必须能说「不用管」", () => {
  test("★ ACCEPT：健康时给绿灯，且明说不需要人介入", () => {
    // 一个只会说黄/红的系统等于没有系统——它会退化成另一个骚扰人的 micro-manager。
    const a = assess({ ...healthy, untyped: 0, total: 4 });
    expect(a.status).toBe("healthy");
    expect(a.humanAttention).toBe(false);
    expect(a.headline).toContain("不需要");
  });

  test("只有 warn 级信号 → 黄灯，但仍不要求人介入", () => {
    const a = assess({ ...healthy, untyped: 20, total: 100 });
    expect(a.status).toBe("degraded");
    expect(a.humanAttention).toBe(false);
  });

  test("有 bad 级信号 → 红灯并要求人介入", () => {
    const a = assess({ ...healthy, untyped: 60, total: 100 });
    expect(a.status).toBe("action-required");
    expect(a.humanAttention).toBe(true);
  });

  test("★ 最多给 3 条解释 —— 不做 alert spam", () => {
    const a = assess({
      now,
      untyped: 60,
      total: 100,
      stock7d: [10, 20, 30, 40, 50, 60, 70],
      items: Array.from({ length: 20 }, (_, i) => ({
        id: i,
        type: "bug",
        createdAt: day(20),
        closedAt: null,
      })),
    });
    expect(a.explanations.length).toBeLessThanOrEqual(3);
  });

  test("★ 恢复中要被说出来，而不是只报「存量高」", () => {
    const a = assess({
      now,
      untyped: 0,
      total: 10,
      stock7d: [70, 60, 50, 40, 30, 20, 10],
      items: [{ id: 1, type: "bug", createdAt: day(1), closedAt: null }],
    });
    expect(a.headline + a.explanations.join()).toMatch(/恢复|下降|burn/);
  });
});

describe("capExplanations —— 上限必须可直接测", () => {
  test("★ REJECT：超过上限被截断", () => {
    expect(capExplanations(["a", "b", "c", "d", "e"]).length).toBe(MAX_EXPLANATIONS);
  });
  test("ACCEPT：不超过上限时原样返回（不得一律截成空）", () => {
    expect(capExplanations(["a", "b"])).toEqual(["a", "b"]);
  });
  test("空输入 → 空数组", () => {
    expect(capExplanations([])).toEqual([]);
  });
});

describe("★ 斜率必须算自无偏输入", () => {
  test("REJECT：净值序列递增 → 斜率为正", () => {
    expect(backlogSlope(netToCumulative([2, 3, 4, 5]))).toBeGreaterThan(0);
  });
  test("ACCEPT：净值有正有负但总体持平 → 斜率接近 0", () => {
    expect(Math.abs(backlogSlope(netToCumulative([3, -3, 2, -2])))).toBeLessThan(1.5);
  });
  test("★ 净值全为负 → 斜率必须为负（正在恢复）", () => {
    expect(backlogSlope(netToCumulative([-5, -4, -6, -3]))).toBeLessThan(0);
  });
  test("空输入 → 空序列，斜率 0", () => {
    expect(netToCumulative([])).toEqual([]);
    expect(backlogSlope(netToCumulative([]))).toBe(0);
  });
});
