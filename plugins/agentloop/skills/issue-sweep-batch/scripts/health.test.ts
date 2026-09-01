import { describe, expect, test } from "bun:test";
import {
  AGE_BUCKETS,
  AGE_SCALE,
  ageBucketOf,
  agingBuckets,
  assess,
  backlogSlope,
  capExplanations,
  detectors,
  flowRatio,
  type HealthInput,
  MAX_EXPLANATIONS,
  netToCumulative,
  STALE_BUCKETS,
  STALE_FROM_DAYS,
  T,
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
    // ★ 正控：基线里**必须**有 symptom，否则 undiagnosed-symptom 的 accept 臂是空的——
    // 「仪器看过了、没事」与「压根没东西可看」同色。这条在 TTL 内，那条已判决关闭。
    { id: 7, type: "symptom", createdAt: day(2), closedAt: null },
    { id: 8, type: "symptom", createdAt: day(9), closedAt: day(6) },
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
    const f = flowRatio({ now, items: [] });
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
    // 3 = id1(1d) + id2(2d) + id7(2d 的 symptom 正控)。其余都已关闭。
    // 逐档相加而不是写死档名：加档时这条不该需要改。
    expect(AGE_BUCKETS.reduce((n, k) => n + b[k], 0)).toBe(3);
    // 基线里没有陈货：所有计入陈货的档都得是 0
    for (const k of STALE_BUCKETS) expect(b[k]).toBe(0);
  });

  test("★ 空输入返回全零的**每一个**桶，不是空对象（缺桶会让图少一根柱子）", () => {
    const b = agingBuckets([], now);
    expect(Object.keys(b).length).toBe(AGE_SCALE.length);
    expect(Object.values(b).every((v) => v === 0)).toBe(true);
  });

  test("陈货按档落位：30 天 → 30-90d，200 天 → >90d", () => {
    const b = agingBuckets(
      [
        { id: 1, type: "bug", createdAt: day(30), closedAt: null },
        { id: 2, type: "bug", createdAt: day(200), closedAt: null },
      ],
      now,
    );
    expect(b["30-90d"]).toBe(1);
    expect(b[">90d"]).toBe(1);
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

describe("★ undiagnosed-symptom —— 「判完了没事」与「没人判」不许同色", () => {
  // symptom 的产物是一个**判决**，不是知识。判成 bug 会改类型离开本桶，其余判决
  // （test-defect / env / stale / normal）一律关闭。所以「仍然 open 且超期」
  // 就是「还没有人给出判决」——这个推断的前提钉在 classify.test.ts 的闭合词表那条。
  /** 新契约：没配 TTL 这个 detector 整个不跑，所以这一组显式配上。 */
  const TTL = { thresholds: { symptomTtlDays: 7 } };
  const sym = (id: number, ageDays: number, closed: number | null = null) => ({
    id,
    type: "symptom",
    createdAt: day(ageDays),
    closedAt: closed === null ? null : day(closed),
  });

  test("★ 正控：健康基线里**确实有** symptom，accept 臂才不是空的", () => {
    // 一个「什么都没看到」的 detector 满足每一条「它没报警」的断言。
    expect(healthy.items.filter((x) => x.type === "symptom").length).toBeGreaterThan(0);
    expect(healthy.items.some((x) => x.type === "symptom" && !x.closedAt)).toBe(true);
  });

  test("★ ACCEPT：symptom 都在 TTL 内 → 不触发", () => {
    expect(detectors(healthy).map((s) => s.id)).not.toContain("undiagnosed-symptom");
  });

  test("超期 ≥ 门槛条数 → warn，证据里给得出数字", () => {
    const i: HealthInput = {
      ...healthy,
      ...TTL,
      // 2 条超期 / 6 条 open symptom = 33%，在 bad 门槛之下：积压的是个别条目，
      // 不是判决通道本身停了。
      items: [
        ...healthy.items,
        sym(20, T.symptomTtlDays + 1),
        sym(21, T.symptomTtlDays + 3),
        sym(22, 1),
        sym(23, 1),
        sym(24, 2),
      ],
    };
    const s = detectors(i).find((x) => x.id === "undiagnosed-symptom");
    expect(s).toBeDefined();
    expect(s?.severity).toBe("warn");
    expect(s?.evidence).toContain("2");
  });

  test("超期占比过半 → bad（叫人）", () => {
    const i: HealthInput = {
      ...healthy,
      ...TTL,
      // 3 条超期 / 4 条 open symptom（含基线那条新鲜的）= 75%
      items: [
        ...healthy.items,
        sym(20, T.symptomTtlDays + 1),
        sym(21, T.symptomTtlDays + 2),
        sym(22, T.symptomTtlDays + 5),
      ],
    };
    const s = detectors(i).find((x) => x.id === "undiagnosed-symptom");
    expect(s?.severity).toBe("bad");
  });

  test("★ ACCEPT：只有一条超期不叫人（可能只是刚好跨过）", () => {
    const i: HealthInput = {
      ...healthy,
      ...TTL,
      items: [...healthy.items, sym(20, T.symptomTtlDays + 1)],
    };
    expect(detectors(i).map((s) => s.id)).not.toContain("undiagnosed-symptom");
  });

  test("★ 已关闭的超期 symptom 不计入 —— 关闭就是判决已做出", () => {
    const i: HealthInput = {
      ...healthy,
      ...TTL,
      items: [
        ...healthy.items,
        sym(20, T.symptomTtlDays + 9, 1),
        sym(21, T.symptomTtlDays + 8, 1),
        sym(22, T.symptomTtlDays + 7, 2),
      ],
    };
    expect(detectors(i).map((s) => s.id)).not.toContain("undiagnosed-symptom");
  });

  test("★ 判别力：它看的是「未判决的 symptom」，不是笼统的年龄", () => {
    // 同一批陈旧项，类型换成 bug 就不该触发这个 detector（那是 stale-work 的面）。
    const aged = [sym(20, T.symptomTtlDays + 1), sym(21, T.symptomTtlDays + 3)];
    const asBug = aged.map((x) => ({ ...x, type: "bug" }));
    expect(
      detectors({ ...healthy, ...TTL, items: [...healthy.items, ...aged] }).map((s) => s.id),
    ).toContain("undiagnosed-symptom");
    expect(
      detectors({ ...healthy, ...TTL, items: [...healthy.items, ...asBug] }).map((s) => s.id),
    ).not.toContain("undiagnosed-symptom");
  });
});

describe("★ ageBucketOf —— 柱子的数与点开的那批必须出自同一个函数", () => {
  // 页面上的年龄柱可以点，点了就按那个桶过滤 issue 列表。如果柱子的计数和过滤器
  // 各自实现一遍边界，两边会悄悄漂移——**柱子说 108、点开给出 97** 与
  // 「柱子是对的」在页面上完全同色。所以桶的归属只有这一个实现，
  // 序列化进每条 item，前端只做字符串相等。
  test("边界逐个钉死（左闭右开）", () => {
    expect(ageBucketOf(0)).toBe("<1d");
    expect(ageBucketOf(0.99)).toBe("<1d");
    expect(ageBucketOf(1)).toBe("1-3d");
    expect(ageBucketOf(2.99)).toBe("1-3d");
    expect(ageBucketOf(3)).toBe("3-7d");
    expect(ageBucketOf(6.99)).toBe("3-7d");
    expect(ageBucketOf(7)).toBe("7-14d");
    expect(ageBucketOf(13.99)).toBe("7-14d");
    expect(ageBucketOf(14)).toBe("14-30d");
    expect(ageBucketOf(29.99)).toBe("14-30d");
    expect(ageBucketOf(30)).toBe("30-90d");
    expect(ageBucketOf(89.99)).toBe("30-90d");
    expect(ageBucketOf(90)).toBe(">90d");
    expect(ageBucketOf(999)).toBe(">90d");
  });

  test("★ 反漂移：agingBuckets 的计数必须与逐条 ageBucketOf 完全一致", () => {
    const items = [0.2, 1.5, 4, 8, 20, 6.99, 7.01].map((d, k) => ({
      id: k,
      type: "bug",
      createdAt: day(d),
      closedAt: null,
    }));
    const byChart = agingBuckets(items, now);
    const byItem: Record<string, number> = {};
    for (const i of items) {
      const b = ageBucketOf((now.getTime() - new Date(i.createdAt).getTime()) / 86_400_000);
      byItem[b] = (byItem[b] ?? 0) + 1;
    }
    for (const b of AGE_BUCKETS) expect(byChart[b]).toBe(byItem[b] ?? 0);
  });

  test("★ 已关闭的不进柱子 —— 点开也不该出现它们", () => {
    const items = [
      { id: 1, type: "bug", createdAt: day(20), closedAt: day(1) },
      { id: 2, type: "bug", createdAt: day(20), closedAt: null },
    ];
    expect(agingBuckets(items, now)["14-30d"]).toBe(1);
  });
});

describe("★ 年龄刻度 —— 一个表，别处都从它派生", () => {
  test("AGE_SCALE 的下界严格递增，且第一档从 0 起", () => {
    expect(AGE_SCALE[0].from).toBe(0);
    for (let i = 1; i < AGE_SCALE.length; i++)
      expect(AGE_SCALE[i].from).toBeGreaterThan(AGE_SCALE[i - 1].from);
  });

  test("★ AGE_BUCKETS 与 AGE_SCALE 同源 —— 两份清单会漂移", () => {
    expect([...AGE_BUCKETS]).toEqual(AGE_SCALE.map((x) => x.key));
  });

  test("★ 陈货门槛也从这张表派生：>=7d 的档全部计入 stale", () => {
    // 加档（14-30d / 30-90d / >90d）时最容易漏的就是这里：detector 里手写
    // ages["7-14d"] + ages[">14d"] 的话，新加的档会**悄悄不算进陈货**，
    // 于是「陈货变少了」与「新档没接线」同色。
    expect(STALE_BUCKETS).toEqual(
      AGE_SCALE.filter((x) => x.from >= STALE_FROM_DAYS).map((x) => x.key),
    );
    expect(STALE_BUCKETS).toContain(">90d");
    expect(STALE_BUCKETS).not.toContain("3-7d");
  });

  test("★ 新档真的计入 stale-work：一条 200 天的必须被数进去", () => {
    const i: HealthInput = {
      ...healthy,
      items: [
        { id: 90, type: "bug", createdAt: day(200), closedAt: null },
        { id: 91, type: "bug", createdAt: day(150), closedAt: null },
        { id: 92, type: "bug", createdAt: day(100), closedAt: null },
      ],
      stock7d: [10, 10, 10, 10, 10, 10, 10],
    };
    const s = detectors(i).find((x) => x.id === "stale-work");
    expect(s).toBeDefined();
    expect(s?.evidence).toContain("3/3");
  });
});

describe("★ 门槛可按仓库覆盖 —— arc 的标定不该硬编码进分发出去的插件", () => {
  // 本地跨引擎 review 报的 P2：symptom 的 7 天 TTL 是从 **arc 自己**的 test-sweep
  // 历史标出来的，把它随插件发给每个消费仓库，会让诊断节奏更慢的仓库天天收到
  // action-required。插件出**机制与默认值**，具体数字住消费仓库的 profile。
  const overdue = (days: number, id: number) => ({
    id,
    type: "symptom",
    createdAt: day(days),
    closedAt: null,
  });

  test("★ 抬高 TTL 后，原本超期的那批不再触发（默认值不是唯一可能）", () => {
    const items = [...healthy.items, overdue(8, 60), overdue(9, 61)];
    expect(
      detectors({ ...healthy, items, thresholds: { symptomTtlDays: 7 } }).map((s) => s.id),
    ).toContain("undiagnosed-symptom");
    expect(
      detectors({ ...healthy, items, thresholds: { symptomTtlDays: 30 } }).map((s) => s.id),
    ).not.toContain("undiagnosed-symptom");
  });

  test("★ 只覆盖给到的那一项，其余仍用默认（部分覆盖不得清空整张表）", () => {
    const items = [...healthy.items, overdue(40, 62), overdue(41, 63)];
    const s = detectors({ ...healthy, items, thresholds: { symptomTtlDays: 30 } });
    expect(s.map((x) => x.id)).toContain("undiagnosed-symptom");
    // untyped / stale 的门槛没被这次覆盖动到
    expect(T.untypedBad).toBe(0.25);
  });

  test("★ 没在 profile 里配 TTL → 这个 detector 整个不跑（不拿 arc 的节奏判别人）", () => {
    // fail-closed 的方向是**不告警**：一个用别人标定得出的 action-required
    // 比没有这个信号更糟——它会让人停下来查一件根本不存在的事。
    const items = [...healthy.items, overdue(40, 64), overdue(41, 65)];
    expect(detectors({ ...healthy, items }).map((s) => s.id)).not.toContain("undiagnosed-symptom");
    expect(detectors({ ...healthy, items, thresholds: {} }).map((s) => s.id)).not.toContain(
      "undiagnosed-symptom",
    );
  });

  test("★ ACCEPT：配上就跑（否则「永不触发」满足上一条）", () => {
    const items = [...healthy.items, overdue(40, 66), overdue(41, 67)];
    expect(
      detectors({ ...healthy, items, thresholds: { symptomTtlDays: 7 } }).map((s) => s.id),
    ).toContain("undiagnosed-symptom");
  });
});
