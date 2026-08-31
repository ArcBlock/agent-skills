import { describe, expect, test } from "bun:test";
import {
  axisFor,
  type ClassificationRecord,
  groupingQuestion,
  type Neighborhood,
  revalidationReasons,
  typeOf,
} from "./classify";

describe("typeOf —— 从 label 判类型", () => {
  test("bug / feature / idea / research 各自归位", () => {
    expect(typeOf(["bug"])).toBe("bug");
    expect(typeOf(["feature"])).toBe("feature");
    expect(typeOf(["enhancement"])).toBe("feature");
    expect(typeOf(["idea"])).toBe("idea");
    expect(typeOf(["research"])).toBe("research");
  });

  test("bug 优先于其他（一条同时挂 bug 和 idea 时按 bug 处理）", () => {
    expect(typeOf(["idea", "bug"])).toBe("bug");
  });

  test("★ 自动生成的报告不是工作项，即使同时挂了 bug", () => {
    // 实测回归：#5625 同时挂 bug + nightly-test-report，被当成 bug 候选混进了分类。
    // 报告是 skill 自己产出的 QA 发现，有自己的处理通道，不是「有人开的工作项」。
    expect(typeOf(["bug", "nightly-test-report"])).toBe("report");
    expect(typeOf(["bug", "test-sweep-report"])).toBe("report");
    expect(typeOf(["nightly-test-report"])).toBe("report");
  });

  test("★ 无类型标签 → untyped，不得默默当成 bug", () => {
    // arc 实测：近 14 天新建的 770 条里 268 条（34%）没有任何类型标签。
    // 把它们默认成 bug 会污染 bug 的分类轴。
    expect(typeOf([])).toBe("untyped");
    expect(typeOf(["P1", "agent:hold"])).toBe("untyped");
  });
});

describe("axisFor —— 分类轴按类型不同（本 skill 从 epic 构建器泛化为全局分类器的核心）", () => {
  test("bug 按缺陷层", () => {
    expect(axisFor("bug")).toBe("defectLayer");
  });
  test("feature 按能力面", () => {
    expect(axisFor("feature")).toBe("capabilityArea");
  });
  test("idea 按能力面（与 feature 同轴，差别在成熟度不在轴）", () => {
    expect(axisFor("idea")).toBe("capabilityArea");
  });
  test("research 按待答问题", () => {
    expect(axisFor("research")).toBe("openQuestion");
  });
  test("★ untyped 没有轴 —— 必须先定类型，不能硬分", () => {
    expect(axisFor("untyped")).toBeNull();
  });
});

describe("groupingQuestion —— 每个轴的聚簇判据是一句可回答的问题", () => {
  test("每种类型都给出**不同**的问题（同一句话套所有类型 = 没有真的分轴）", () => {
    const qs = (["bug", "feature", "idea", "research"] as const).map(groupingQuestion);
    expect(new Set(qs).size).toBeGreaterThan(1);
    expect(qs.every((q) => q.length > 0)).toBe(true);
  });
  test("bug 的判据是「同一个修复方向」", () => {
    expect(groupingQuestion("bug")).toContain("修复方向");
  });
  test("feature 的判据不是修复方向（否则就是把 bug 的轴硬套上来）", () => {
    expect(groupingQuestion("feature")).not.toContain("修复方向");
  });
  test("untyped 返回空 —— 没有轴就没有判据", () => {
    expect(groupingQuestion("untyped")).toBe("");
  });
});

describe("revalidationReasons —— 分类什么时候需要重做", () => {
  const now = new Date("2026-08-30T12:00:00Z");
  const rec: ClassificationRecord = {
    issue: 100,
    fingerprint: "fp-old",
    classifiedAt: "2026-08-29T12:00:00Z",
    layer: "gate-credibility",
    type: "bug",
  };
  const quiet: Neighborhood = { closedNeighbors: [], unblockedBy: [], newHumanInput: false };

  test("ACCEPT：自身没变、邻域没变、未过 TTL → 无理由，跳过", () => {
    const r = revalidationReasons(rec, "fp-old", quiet, 14, now);
    expect(r).toEqual([]);
  });

  test("REJECT：指纹变了 → 有理由", () => {
    const r = revalidationReasons(rec, "fp-new", quiet, 14, now);
    expect(r.some((x) => x.includes("正文或 label"))).toBe(true);
  });

  test("★ REJECT：自身没变，但邻居关掉了 → 仍需重验", () => {
    // 这是 GitHub label 给不出、graph 才有的信号：
    // 一条 issue 自己一个字没改，但它依赖的那条合了，分类可能已经不成立。
    const r = revalidationReasons(rec, "fp-old", { ...quiet, closedNeighbors: [88] }, 14, now);
    expect(r.some((x) => x.includes("邻域"))).toBe(true);
    expect(r.join()).toContain("88");
  });

  test("★ REJECT：被解锁 → 需重验（blocked 时的分类可能是「等别人」）", () => {
    const r = revalidationReasons(rec, "fp-old", { ...quiet, unblockedBy: [77] }, 14, now);
    expect(r.some((x) => x.includes("解锁"))).toBe(true);
  });

  test("REJECT：有新的人类输入 → 需重验（人的建议可能改变归类）", () => {
    const r = revalidationReasons(rec, "fp-old", { ...quiet, newHumanInput: true }, 14, now);
    expect(r.some((x) => x.includes("人类"))).toBe(true);
  });

  test("REJECT：过了 TTL → 需重验", () => {
    const old = { ...rec, classifiedAt: "2026-07-01T12:00:00Z" };
    expect(revalidationReasons(old, "fp-old", quiet, 14, now).length).toBeGreaterThan(0);
  });

  test("★ 未分类过（无 layer）→ 必须分类，且理由要说清是「从未分类」", () => {
    const never = { ...rec, layer: null };
    const r = revalidationReasons(never, "fp-old", quiet, 14, now);
    expect(r.some((x) => x.includes("从未分类"))).toBe(true);
  });

  test("★ 从未分类时不得同时报 TTL —— 那是把「没有分类」说成「分类旧了」", () => {
    // 实测显示缺陷：从未分类的条目传 epoch 当 classifiedAt，报出「已过 TTL（20696 天）」，
    // 看起来像 bug。没有分类过就没有「旧」这回事。
    const never = { ...rec, layer: null, classifiedAt: new Date(0).toISOString() };
    const r = revalidationReasons(never, "fp-old", quiet, 14, now);
    expect(r.some((x) => x.includes("从未分类"))).toBe(true);
    expect(r.some((x) => x.includes("TTL"))).toBe(false);
  });

  test("多个理由同时成立时全部列出（不是短路返回第一条）", () => {
    const r = revalidationReasons(
      rec,
      "fp-new",
      { closedNeighbors: [1], unblockedBy: [2], newHumanInput: true },
      14,
      now,
    );
    expect(r.length).toBeGreaterThanOrEqual(4);
  });

  test("★ 守卫自身的 accept 臂：一个永远返回理由的实现会让「跳过」失效", () => {
    // 若 revalidationReasons 退化成总是返回非空，增量就没了 —— 本条钉住那个方向。
    const r = revalidationReasons(rec, "fp-old", quiet, 14, now);
    expect(r.length).toBe(0);
  });
});
