import { describe, expect, test } from "bun:test";
import {
  coverage,
  type Decision,
  decisionGroups,
  deriveRules,
  proposeType,
  type Rule,
  replayGuard,
  singletons,
  type Untyped,
} from "./typing";

const U = (id: number, title: string, body = "", labels: string[] = []): Untyped => ({
  id,
  title,
  body,
  labels,
});

describe("proposeType —— 有证据才提议，没证据就说不知道", () => {
  const rules: Rule[] = [
    { id: "r1", kind: "titlePrefix", pattern: "[design]", type: "feature", support: 4 },
    { id: "r2", kind: "bodySkill", pattern: "nightly-test", type: "report", support: 9 },
  ];

  test("ACCEPT：命中规则 → 给出类型 + 证据 + 是哪条规则", () => {
    const p = proposeType(U(1, "[design] 工厂的并发上限"), rules);
    expect(p.type).toBe("feature");
    expect(p.rule).toBe("r1");
    expect(p.evidence).toContain("[design]");
  });

  test("★ REJECT：没命中任何规则 → type 为 null，不得瞎猜", () => {
    const p = proposeType(U(2, "某个说不清的东西"), rules);
    expect(p.type).toBeNull();
    expect(p.rule).toBeNull();
  });

  test("★ 两条规则给出冲突类型 → 不提议，标为冲突（让人来断）", () => {
    const conflicting: Rule[] = [
      { id: "a", kind: "titlePrefix", pattern: "[x]", type: "feature", support: 3 },
      { id: "b", kind: "titlePrefix", pattern: "[x]", type: "bug", support: 3 },
    ];
    const p = proposeType(U(3, "[x] 两边都像"), conflicting);
    expect(p.type).toBeNull();
    expect(p.conflict).toBe(true);
  });

  test("支持度低于门槛的规则不参与提议（一次人类判断不足以成规则）", () => {
    const weak: Rule[] = [
      { id: "w", kind: "titlePrefix", pattern: "[y]", type: "bug", support: 1 },
    ];
    expect(proposeType(U(4, "[y] 只有一次先例"), weak).type).toBeNull();
  });
});

describe("deriveRules —— 从人类判断里长出规则", () => {
  test("ACCEPT：同一个标题前缀被人反复判成同一类 → 长出规则", () => {
    const ds: Decision[] = [
      { id: 1, title: "[design] a", body: "", labels: [], type: "feature", by: "human" },
      { id: 2, title: "[design] b", body: "", labels: [], type: "feature", by: "human" },
      { id: 3, title: "[design] c", body: "", labels: [], type: "feature", by: "human" },
    ];
    const rs = deriveRules(ds);
    const r = rs.find((x) => x.kind === "titlePrefix" && x.pattern === "[design]");
    expect(r?.type).toBe("feature");
    expect(r?.support).toBe(3);
  });

  test("★ REJECT：同一前缀被判成不同类 → 不得长出规则（人自己都没一致）", () => {
    const ds: Decision[] = [
      { id: 1, title: "[x] a", body: "", labels: [], type: "feature", by: "human" },
      { id: 2, title: "[x] b", body: "", labels: [], type: "bug", by: "human" },
      { id: 3, title: "[x] c", body: "", labels: [], type: "feature", by: "human" },
    ];
    expect(deriveRules(ds).some((r) => r.pattern === "[x]")).toBe(false);
  });

  test("★ 只从人类判断学，agent 自己的提议不得成为下一轮的规则来源", () => {
    // 否则第一次猜错会自我强化——「模型学自己的输出」这一类退化。
    const ds: Decision[] = [
      { id: 1, title: "[z] a", body: "", labels: [], type: "bug", by: "agent" },
      { id: 2, title: "[z] b", body: "", labels: [], type: "bug", by: "agent" },
      { id: 3, title: "[z] c", body: "", labels: [], type: "bug", by: "agent" },
    ];
    expect(deriveRules(ds)).toEqual([]);
  });

  test("空判断集 → 空规则集（不得凭空造规则）", () => {
    expect(deriveRules([])).toEqual([]);
  });
});

describe("★ replayGuard —— 规则必须可证伪", () => {
  const ds: Decision[] = [
    { id: 1, title: "[design] a", body: "", labels: [], type: "feature", by: "human" },
    { id: 2, title: "[design] b", body: "", labels: [], type: "feature", by: "human" },
    { id: 3, title: "[design] c", body: "", labels: [], type: "feature", by: "human" },
    { id: 4, title: "[design] 例外", body: "", labels: [], type: "bug", by: "human" },
  ];

  test("REJECT：会预测错任何一条人类判断的规则被拒绝", () => {
    const bad: Rule[] = [
      { id: "r", kind: "titlePrefix", pattern: "[design]", type: "feature", support: 3 },
    ];
    const kept = replayGuard(bad, ds);
    expect(kept).toEqual([]); // #4 是反例
  });

  test("ACCEPT：与全部人类判断一致的规则被保留", () => {
    const ok: Rule[] = [
      { id: "r", kind: "titlePrefix", pattern: "[design]", type: "feature", support: 3 },
    ];
    const consistent = ds.slice(0, 3);
    expect(replayGuard(ok, consistent).length).toBe(1);
  });

  test("★ 一个不预测任何东西的规则集通不过 accept 臂 —— 覆盖率必须真的涨", () => {
    // 「全部拒绝」满足每一条 reject 断言。用覆盖率把这条钉死。
    const items = [U(1, "[design] x"), U(2, "[design] y")];
    expect(coverage(items, []).ratio).toBe(0);
    const ok: Rule[] = [
      { id: "r", kind: "titlePrefix", pattern: "[design]", type: "feature", support: 3 },
    ];
    expect(coverage(items, ok).ratio).toBe(1);
  });
});

describe("coverage —— 学习有没有真的发生，看这个数", () => {
  test("覆盖率 = 能被自动提议的比例；空输入是 0 不是 NaN", () => {
    expect(coverage([], []).ratio).toBe(0);
    expect(Number.isFinite(coverage([], []).ratio)).toBe(true);
  });

  test("★ 加入一条来自人类判断的新规则后，覆盖率必须**严格上升**", () => {
    const items = [U(1, "[design] a"), U(2, "[design] b"), U(3, "别的")];
    const before = coverage(items, []).ratio;
    const rules = deriveRules([
      { id: 9, title: "[design] x", body: "", labels: [], type: "feature", by: "human" },
      { id: 10, title: "[design] y", body: "", labels: [], type: "feature", by: "human" },
      { id: 11, title: "[design] z", body: "", labels: [], type: "feature", by: "human" },
    ]);
    const after = coverage(items, rules).ratio;
    expect(after).toBeGreaterThan(before);
  });
});

describe("decisionGroups —— 让人做最少次数的判断", () => {
  const items: Untyped[] = [
    U(1, "[epic] a", "skill:epic-conductor"),
    U(2, "[epic] b", "skill:epic-conductor"),
    U(3, "c", "skill:epic-conductor"),
    U(4, "[task] d", ""),
    U(5, "[task] e", ""),
    U(6, "孤例", ""),
  ];

  test("ACCEPT：按共享特征分组，且**同一同质档内**大的排前", () => {
    // 契约是「先同质度、同档内再看覆盖量」——不是纯按大小。
    // 一个大而杂的组顶到最前，正是最容易被批错的那一组。
    const g = decisionGroups(items, []);
    const tier = (h: number) => (h >= 0.8 ? 2 : h >= 0.5 ? 1 : 0);
    for (let i = 1; i < g.length; i++) {
      const prev = tier(g[i - 1].homogeneity);
      const cur = tier(g[i].homogeneity);
      expect(prev).toBeGreaterThanOrEqual(cur);
      if (prev === cur) expect(g[i - 1].ids.length).toBeGreaterThanOrEqual(g[i].ids.length);
    }
    // skill 组仍然存在，只是不再天然排第一
    expect(g.some((x) => x.feature === "skill:epic-conductor" && x.ids.length === 3)).toBe(true);
  });

  test("★ 贪心去重：一条项只被算进一个组，不得重复计数", () => {
    const g = decisionGroups(items, []);
    const all = g.flatMap((x) => x.ids);
    expect(new Set(all).size).toBe(all.length);
  });

  test("★ 小于 minSize 的组不出现（一条也叫『批量』是自欺）", () => {
    expect(decisionGroups(items, []).every((x) => x.ids.length >= 2)).toBe(true);
  });

  test("★ singletons 如实报出无法批量的那些，不假装能批", () => {
    const g = decisionGroups(items, []);
    expect(singletons(items, g)).toContain(6);
  });

  test("空输入 → 空组 + 空 singleton，不抛", () => {
    expect(decisionGroups([], [])).toEqual([]);
    expect(singletons([], [])).toEqual([]);
  });

  test("已有规则给出 hint，但 hint 只是提示不是结论（type 仍由人定）", () => {
    const rules: Rule[] = [
      { id: "r", kind: "bodySkill", pattern: "epic-conductor", type: "feature", support: 3 },
    ];
    const g = decisionGroups(items, rules);
    // 按特征找那一组，而不是假定它排第一（排序契约已改为同质度优先）
    const skillGroup = g.find((x) => x.feature === "skill:epic-conductor");
    expect(skillGroup?.hint).toBe("feature");
    // 没有规则时同一组的 hint 必须是 null —— hint 来自规则，不是凭空产生
    expect(
      decisionGroups(items, []).find((x) => x.feature === "skill:epic-conductor")?.hint,
    ).toBeNull();
  });
});

describe("★ 同质度 —— 大而杂的组不该排在前面", () => {
  test("REJECT：同一 skill 产出但标题前缀五花八门 → 同质度低", () => {
    // 实测缺陷：skill:epic-conductor 的 22 条里混着 [needs-decision] / [follow-up] /
    // [chore] / 文档。skill 是**出处**信号，不是类型信号。
    const mixed: Untyped[] = [
      U(1, "[needs-decision] a", "skill:epic-conductor"),
      U(2, "[follow-up] b", "skill:epic-conductor"),
      U(3, "[chore] c", "skill:epic-conductor"),
      U(4, "无前缀 d", "skill:epic-conductor"),
    ];
    const g = decisionGroups(mixed, []);
    expect(g[0].homogeneity).toBeLessThan(0.5);
  });

  test("ACCEPT：前缀一致的组同质度为 1", () => {
    const same: Untyped[] = [
      U(1, "[test-sweep] a"),
      U(2, "[test-sweep] b"),
      U(3, "[test-sweep] c"),
    ];
    expect(decisionGroups(same, [])[0].homogeneity).toBe(1);
  });

  test("★ 排序先看同质度：一个大而杂的组不得挤在小而齐的组前面", () => {
    const items: Untyped[] = [
      U(1, "[a] x", "skill:mixed"),
      U(2, "[b] y", "skill:mixed"),
      U(3, "[c] z", "skill:mixed"),
      U(4, "[d] w", "skill:mixed"),
      U(5, "[same] p", ""),
      U(6, "[same] q", ""),
    ];
    const g = decisionGroups(items, []);
    const pure = g.find((x) => x.feature.includes("[same]"));
    const mixed = g.find((x) => x.feature.includes("mixed"));
    expect(pure).toBeDefined();
    if (mixed) expect(g.indexOf(pure!)).toBeLessThan(g.indexOf(mixed));
  });
});
