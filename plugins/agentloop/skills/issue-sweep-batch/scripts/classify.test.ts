import { describe, expect, test } from "bun:test";
import {
  axisFor,
  type ClassificationRecord,
  canonicalLabelFor,
  groupingQuestion,
  type Neighborhood,
  revalidationReasons,
  SYMPTOM_VERDICTS,
  type SymptomVerdict,
  typeOf,
  VERDICT_KEEPS_OPEN,
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

describe("★ symptom —— 未诊断的观察既不是缺陷也不是报告", () => {
  // 走查报出的单条失败意味着「出现了预期外的东西」，但它是不是缺陷、修复方向在哪，
  // 都还没有答案。塞进 bug 会让「已确认缺陷」与「待定项」同色，而 bug 的轴
  // （defectLayer = 能否被同一个修复方向覆盖）在方向未知时根本没法赋。
  // 塞进 report 则让「诊断完发现不是缺陷」与「根本没人看」同色。
  test("test-sweep-failure / nightly-test-failure → symptom", () => {
    expect(typeOf(["test-sweep-failure"])).toBe("symptom");
    expect(typeOf(["nightly-test-failure"])).toBe("symptom");
    expect(typeOf(["P2", "test-sweep-failure"])).toBe("symptom");
  });

  test("★ 判决一旦做出就离开本桶：同时挂 bug 时按 bug", () => {
    // symptom 的产物是一个判决。人（或 agent）诊断完加上 bug label，
    // 就是这条判决本身——此时它是缺陷，不再是待诊断观察。
    expect(typeOf(["test-sweep-failure", "bug"])).toBe("bug");
  });

  test("★ 运行汇总优先于单条失败：同时挂 report label 时按 report", () => {
    // 「检测到 N 处失败（timestamp）」是一次运行的汇总，不是一条症状。
    expect(typeOf(["test-sweep-failure", "test-sweep-report"])).toBe("report");
    expect(typeOf(["test-sweep-failure", "nightly-test-report"])).toBe("report");
  });

  test("symptom 与 research 同轴（都是待答问题）", () => {
    expect(axisFor("symptom")).toBe("openQuestion");
  });

  test("★ 同轴不等于同问题：symptom 的聚簇问题必须与 research 不同", () => {
    // 用同一句话套两个类型就等于没有分它们。symptom 问的是「同一次诊断」，
    // research 问的是「同一次调查」——前者必须终结成判决，后者产出知识。
    expect(groupingQuestion("symptom")).not.toBe("");
    expect(groupingQuestion("symptom")).not.toBe(groupingQuestion("research"));
    expect(groupingQuestion("symptom")).toContain("诊断");
  });

  test("★ 判决是闭合词表，且只有 bug 一种是「改类型继续开着」", () => {
    // 这条钉住的是 undiagnosed-symptom detector 的前提：
    // 「open 且超期 = 判决未做出」只有在其余判决**一律关闭**时才成立。
    expect(Object.keys(SYMPTOM_VERDICTS).sort()).toEqual(
      ["bug", "env", "normal", "stale", "test-defect"].sort(),
    );
    expect(VERDICT_KEEPS_OPEN).toEqual(["bug"]);
    for (const v of Object.keys(SYMPTOM_VERDICTS) as SymptomVerdict[]) {
      if (v === "bug") continue;
      expect(VERDICT_KEEPS_OPEN).not.toContain(v);
    }
  });
});

describe("★ 每个类型必须有一个「加上去就能被认回来」的规范 label", () => {
  // 本地 codex 审 #5685 时报的 P2：批量判断单导出的是
  // `gh issue edit N --add-label <类型名>`，而 symptom / report 的类型名**不是**
  // 任何一个 label —— 加上去下一轮仍然是 untyped。「分类做了」与「分类没生效」同色。
  test("★ 往返：canonicalLabelFor(t) 加回去必须还是 t", () => {
    for (const t of ["bug", "feature", "idea", "research", "symptom", "report"] as WorkType[]) {
      const label = canonicalLabelFor(t);
      expect(label).toBeTruthy();
      expect(typeOf([label as string])).toBe(t);
    }
  });

  test("★ untyped 没有规范 label（它不是一个可以「加上」的类型）", () => {
    expect(canonicalLabelFor("untyped")).toBeUndefined();
  });

  test("provenance label 仍然认得出 —— 规范 label 是新增的一条，不是替换", () => {
    // test-sweep-failure 说的是「这条从哪来」，不是「它是什么」。两者都要认。
    expect(typeOf(["test-sweep-failure"])).toBe("symptom");
    expect(typeOf(["nightly-test-report"])).toBe("report");
  });

  test("★ 规范 label 排在最前 —— 它是「类型」，provenance 只是也能推出类型", () => {
    expect(canonicalLabelFor("symptom")).toBe("symptom");
    expect(canonicalLabelFor("report")).toBe("report");
    expect(canonicalLabelFor("bug")).toBe("bug");
  });
});
