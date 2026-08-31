/**
 * 源 conformance —— 任何 WorkItemSource 实现都必须过这一套。
 *
 * 为什么要有这个：本 skill 的判定核心（layer / 路径面 / 三态不相交 / ledger 增量）
 * 与「工作项从哪来」无关。今天来自 GitHub issue，将来来自我们自己的 work object
 * （arc #5540）。**换源不得静默改变行为**——所以两个适配器过同一套断言，
 * 与本仓 provider conformance 的纪律同构。
 *
 * 这套只测**契约**，不测某个后端的内部实现。
 */

import { describe, expect, test } from "bun:test";
import {
  capabilitiesOf,
  claimsFromPr,
  MemoryWorkItemSource,
  type WorkItemSource,
  WorkObjectSource,
} from "./source";

/** 任何实现都要过这一套。新增适配器时把它挂进来。 */
export function runSourceConformance(name: string, make: () => WorkItemSource) {
  describe(`WorkItemSource conformance — ${name}`, () => {
    test("list 返回的每一项都带 id / title / body / labels", async () => {
      const items = await make().list({ state: "open" });
      for (const i of items) {
        expect(typeof i.id).toBe("number");
        expect(typeof i.title).toBe("string");
        expect(Array.isArray(i.labels)).toBe(true);
        expect(i.body === null || typeof i.body === "string").toBe(true);
      }
    });

    test("ACCEPT：按 label 过滤真的收窄了结果", async () => {
      const s = make();
      const all = await s.list({ state: "open" });
      const bugs = await s.list({ state: "open", withLabels: ["bug"] });
      expect(bugs.length).toBeLessThan(all.length);
      expect(bugs.every((i) => i.labels.includes("bug"))).toBe(true);
    });

    test("REJECT：不存在的 label 返回空，而不是全量", async () => {
      const r = await make().list({ state: "open", withLabels: ["__no_such_label__"] });
      expect(r).toEqual([]);
    });

    test("ACCEPT：排除 label 生效，且不吞掉不该排的", async () => {
      const s = make();
      const all = await s.list({ state: "open" });
      const r = await s.list({ state: "open", withoutLabels: ["bug"] });
      expect(r.every((i) => !i.labels.includes("bug"))).toBe(true);
      expect(r.length).toBe(all.filter((i) => !i.labels.includes("bug")).length);
    });

    test("claimedIds 返回被在飞工作认领的 id 集合（G5）", async () => {
      const c = await make().claimedIds();
      expect(c instanceof Set).toBe(true);
    });

    test("epicMembers 返回 epic -> 成员 的映射", async () => {
      const m = await make().epicMembers();
      expect(m instanceof Map).toBe(true);
      for (const [k, v] of m) {
        expect(typeof k).toBe("number");
        expect(Array.isArray(v)).toBe(true);
      }
    });

    test("★ 能力自述必须诚实：声明下推就必须真的下推", async () => {
      const s = make();
      const caps = capabilitiesOf(s);
      if (!caps.pushdown) {
        expect(caps.pushdown).toBe(false);
        return;
      }
      // 声明了下推 = 过滤必须在源侧完成。判据是**严格**少读：
      // 一个「取全量再本地 filter」的实现，两次读的条数相同 —— 用 <= 会放过它，
      // 这个洞是变异测试照出来的（谎称下推的源曾经全绿）。
      expect(typeof s.lastReadCount).toBe("number");
      await s.list({ state: "open" });
      const before = s.lastReadCount as number;
      await s.list({ state: "open", withLabels: ["bug"] });
      const after = s.lastReadCount as number;
      expect(after).toBeLessThan(before);
    });

    test("★ 声明了邻域能力就必须真的提供方法（否则整类失效信号会静默漏掉）", async () => {
      const s = make();
      const caps = capabilitiesOf(s);
      if (caps.neighborhood) {
        expect(typeof s.neighborhood).toBe("function");
      } else {
        // 诚实地声明 false 是允许的，但代价要写明：只能看见自身变化，
        // 「邻居合了导致旧分类不成立」这一类会整类漏掉。
        expect(caps.neighborhood).toBe(false);
      }
    });
  });
}

/* 内存源：conformance 套件自身的参照实现，保证套件不是空跑的。 */
runSourceConformance(
  "memory",
  () =>
    new MemoryWorkItemSource([
      { id: 1, title: "a", body: "落点 `scripts/a.ts`", labels: ["bug"] },
      { id: 2, title: "b", body: null, labels: ["feature"] },
      { id: 3, title: "c", body: "`.claude/verify/checks/x.ts`", labels: ["bug", "epic:99"] },
    ]),
);

describe("WorkObjectSource —— 未实现必须 fail-closed", () => {
  // 这一组是变异测试补出来的：原来只写了 fail-closed 的类，从没断言过它真的 fail。
  // 「声明了但没接线」与「接了线在保护你」在报告上完全同色。
  test("★ 三个方法都必须抛，不得静默返回", async () => {
    const s = new WorkObjectSource();
    await expect(s.list()).rejects.toThrow(/尚未实现/);
    await expect(s.claimedIds()).rejects.toThrow(/尚未实现/);
    await expect(s.epicMembers()).rejects.toThrow(/尚未实现/);
  });

  test("错误信息必须指向落地条件，而不是一句泛泛的 not implemented", async () => {
    const s = new WorkObjectSource();
    await expect(s.list()).rejects.toThrow(/5540/);
  });

  test("它声明了三项能力 —— 落地时 conformance 的诚实臂会验这些声明", () => {
    const c = capabilitiesOf(new WorkObjectSource());
    expect(c.pushdown).toBe(true);
    expect(c.incremental).toBe(true);
    expect(c.writableClassification).toBe(true);
  });
});

describe("conformance 套件自身的 reject 臂", () => {
  test("一个永远返回空的源过不了 ACCEPT 臂（证明套件不是全绿机器）", async () => {
    const broken: WorkItemSource = {
      list: async () => [],
      claimedIds: async () => new Set(),
      epicMembers: async () => new Map(),
    };
    const all = await broken.list({ state: "open" });
    const bugs = await broken.list({ state: "open", withLabels: ["bug"] });
    // ACCEPT 臂要求 bugs.length < all.length；全空源做不到 —— 这正是它该被拒的理由。
    expect(bugs.length < all.length).toBe(false);
  });
});

describe("★ 认领判据必须权威（Codex P2，#5628 评审）", () => {
  test("★ 正文里为了上下文提到的 #N 不算认领", () => {
    // 一个「参考 #1234 的做法」的 PR 会把 #1234 从批量里压掉——那不是认领。
    expect(claimsFromPr({ headRefName: "feat/x", body: "参考 #1234 的做法" })).toEqual([]);
  });

  test("ACCEPT：确定性分支名 claude/issue-<N> 算认领", () => {
    expect(claimsFromPr({ headRefName: "claude/issue-5624", body: "" })).toEqual([5624]);
  });

  test("ACCEPT：Fixes / Part of #N 算认领", () => {
    expect(claimsFromPr({ headRefName: "x", body: "Fixes #999" })).toEqual([999]);
    expect(claimsFromPr({ headRefName: "x", body: "Part of #888" })).toEqual([888]);
  });

  test("ACCEPT：closingIssuesReferences 是最权威的来源", () => {
    expect(claimsFromPr({ headRefName: "x", body: "", closing: [77, 78] })).toEqual([77, 78]);
  });

  test("分支名的多 phase 形态 claude/issue-<N>-p2 也算", () => {
    expect(claimsFromPr({ headRefName: "claude/issue-5624-p2", body: "" })).toEqual([5624]);
  });
});
