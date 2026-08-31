import { describe, expect, test } from "bun:test";
import {
  disjointness,
  fingerprint,
  isSelfMember,
  ledgerDelta,
  pathSurface,
  sameLayer,
} from "./lib";

// ── 真实数据。答案由 2026-08-29/30 那轮人工 batch sweep 验过。──

const BODY_5031 = `heavy 测试层在同一个 commit 上两次跑出不同失败集。
根因定位在 \`.claude/verify/checks/check-tests.ts\` 的分片逻辑，
以及 \`scripts/test-shards.mjs\` 的 worker 预算。`;

const BODY_5596_MEMBER = `26 个包声明的入口 build 后不存在。
落点 \`.claude/verify/checks/check-metadata.ts\` 与各包 package.json。`;

// #5554 / #5417 / #5617 的正文里一个文件路径都没有 —— 这是 unproven 的现场来源
const BODY_NO_PATHS = `peer 应该自报：版本号、系统环境、git 服务、健康指数、网络信息。
工厂不主动探测，peer 自己 publish。`;

// 命令引用 ≠ 编辑目标
const BODY_ONLY_CMD = `复现步骤：在干净 worktree 里跑 \`bun .claude/verify/pre-pr.ts\`，
再跑一次 \`bun .claude/verify/pre-merge.ts --comment 5083\`。`;

describe("pathSurface", () => {
  test("抽出正文里点名的文件，state=measured", () => {
    const s = pathSurface(BODY_5031);
    expect(s.state).toBe("measured");
    expect(s.files).toContain(".claude/verify/checks/check-tests.ts");
    expect(s.files).toContain("scripts/test-shards.mjs");
  });

  test("正文无任何路径 → unproven，files 为空", () => {
    const s = pathSurface(BODY_NO_PATHS);
    expect(s.state).toBe("unproven");
    expect(s.files).toEqual([]);
  });

  test("只出现 pre-pr / pre-merge 的命令引用 → 不算落点，仍是 unproven", () => {
    const s = pathSurface(BODY_ONLY_CMD);
    expect(s.files).not.toContain(".claude/verify/pre-pr.ts");
    expect(s.files).not.toContain(".claude/verify/pre-merge.ts");
    expect(s.state).toBe("unproven");
  });

  test("空正文 → unproven，不抛", () => {
    expect(pathSurface("").state).toBe("unproven");
    expect(pathSurface(null as unknown as string).state).toBe("unproven");
  });

  test("lane 归一到目录，但 files 保留全路径（G3：交集算文件级）", () => {
    const s = pathSurface(BODY_5031);
    expect(s.lanes).toContain(".claude/verify/checks");
    expect(s.files.every((f) => f.includes("."))).toBe(true);
  });
});

describe("disjointness — 三态", () => {
  test("ACCEPT：两边都 measured 且无共同文件 → disjoint", () => {
    const r = disjointness(pathSurface(BODY_5031), pathSurface(BODY_5596_MEMBER));
    expect(r.state).toBe("disjoint");
    expect(r.shared).toEqual([]);
  });

  test("REJECT：共享一个文件 → overlap，并点名那个文件", () => {
    const a = pathSurface("落点 `.claude/verify/checks/check-tests.ts`");
    const b = pathSurface("也要改 `.claude/verify/checks/check-tests.ts` 的分类");
    const r = disjointness(a, b);
    expect(r.state).toBe("overlap");
    expect(r.shared).toEqual([".claude/verify/checks/check-tests.ts"]);
  });

  test("★ 核心：一边 unproven → unproven，绝不是 disjoint", () => {
    const r = disjointness(pathSurface(BODY_5031), pathSurface(BODY_NO_PATHS));
    expect(r.state).toBe("unproven");
    expect(r.state).not.toBe("disjoint");
  });

  test("★ 两边都 unproven → 仍是 unproven（不得因为都没路径就判互不相交）", () => {
    const r = disjointness(pathSurface(BODY_NO_PATHS), pathSurface(BODY_ONLY_CMD));
    expect(r.state).toBe("unproven");
  });

  test("G3 REJECT：同目录不同文件不算相交（目录级会误判）", () => {
    const a = pathSurface("`.claude/verify/checks/check-tests.ts`");
    const b = pathSurface("`.claude/verify/checks/check-metadata.ts`");
    expect(disjointness(a, b).state).toBe("disjoint");
  });

  test("code-located 视同 measured（Step 3 读代码补出的落点可参与判定）", () => {
    const a = {
      files: [".claude/hooks/deny-guarded-issue-close.ts"],
      lanes: [".claude/hooks"],
      state: "code-located" as const,
    };
    const b = pathSurface(BODY_5031);
    expect(disjointness(a, b).state).toBe("disjoint");
  });
});

describe("sameLayer — 按缺陷层，不按症状", () => {
  test("REJECT：症状同为并发争用但修复方向相反 → 不同层（#5487 共享槽位 vs #4749 独占 lease）", () => {
    expect(sameLayer("share-worker-slots", "exclusive-heavy-lease")).toBe(false);
  });
  test("ACCEPT：同一层归一", () => {
    expect(sameLayer("gate-credibility", "gate-credibility")).toBe(true);
  });
});

describe("fingerprint — 增量判据", () => {
  test("正文与 label 都不变 → 指纹相同", () => {
    expect(fingerprint("body", ["bug", "P1"])).toBe(fingerprint("body", ["bug", "P1"]));
  });
  test("label 顺序不影响指纹", () => {
    expect(fingerprint("body", ["P1", "bug"])).toBe(fingerprint("body", ["bug", "P1"]));
  });
  test("正文变了 → 指纹变", () => {
    expect(fingerprint("a", ["bug"])).not.toBe(fingerprint("b", ["bug"]));
  });
  test("label 变了 → 指纹变（新增 epic: 标签必须触发重分类）", () => {
    expect(fingerprint("body", ["bug"])).not.toBe(fingerprint("body", ["bug", "epic:5552"]));
  });
});

describe("ledgerDelta — 避免全量重扫", () => {
  const now = new Date("2026-08-30T12:00:00Z");
  const fresh = {
    issue: 1,
    fingerprint: fingerprint("x", ["bug"]),
    classifiedAt: "2026-08-29T12:00:00Z",
  };
  const old = {
    issue: 2,
    fingerprint: fingerprint("y", ["bug"]),
    classifiedAt: "2026-07-01T12:00:00Z",
  };

  test("ACCEPT：指纹未变且未过 TTL → 跳过（这是效率的全部来源）", () => {
    const d = ledgerDelta([{ number: 1, body: "x", labels: ["bug"] }], [fresh], 14, now);
    expect(d.skipped).toEqual([1]);
    expect(d.toClassify).toEqual([]);
  });

  test("REJECT：指纹变了 → 必须重分类", () => {
    const d = ledgerDelta([{ number: 1, body: "CHANGED", labels: ["bug"] }], [fresh], 14, now);
    expect(d.toClassify).toEqual([1]);
    expect(d.skipped).toEqual([]);
  });

  test("REJECT：过了 TTL → 必须重分类（陈旧记录不得被当新鲜）", () => {
    const d = ledgerDelta([{ number: 2, body: "y", labels: ["bug"] }], [old], 14, now);
    expect(d.toClassify).toEqual([2]);
  });

  test("ledger 里没有的 → 新条目", () => {
    const d = ledgerDelta([{ number: 9, body: "z", labels: ["bug"] }], [], 14, now);
    expect(d.toClassify).toEqual([9]);
    expect(d.fresh).toEqual([9]);
  });

  test("★ 空 ledger 不得让一切都被跳过（守卫自身的 accept 臂）", () => {
    const d = ledgerDelta(
      [
        { number: 1, body: "a", labels: [] },
        { number: 2, body: "b", labels: [] },
      ],
      [],
      14,
      now,
    );
    expect(d.toClassify.length).toBe(2);
  });
});

describe("★ 部分抽取必须被说出来（Codex P1，#5628 评审）", () => {
  // 抽取器只认固定的根目录 + 扩展名白名单。一条同时提到 `.github/workflows/verify.yml`
  // 和 `scripts/a.ts` 的 issue，只抽到后者却被标成 measured——
  // **「完整测量」与「测量了我认识的那部分」同色**。这是三态纪律作用在抽取器自己身上。
  const MIXED = "改 `.github/workflows/verify.yml` 和 `scripts/a.ts`";

  test("★ 有未识别的路径样 token → state 是 partial，不是 measured", () => {
    const s = pathSurface(MIXED);
    expect(s.files).toContain("scripts/a.ts");
    expect(s.state).toBe("partial");
    expect(s.unrecognized).toContain(".github/workflows/verify.yml");
  });

  test("ACCEPT：全部路径都被识别时仍是 measured（不得一律降级）", () => {
    const s = pathSurface("`scripts/a.ts` 与 `.claude/verify/b.ts`");
    expect(s.state).toBe("measured");
    expect(s.unrecognized).toEqual([]);
  });

  test("★ partial 参与不相交判定时只能得 unproven —— 不得判成 disjoint", () => {
    const a = pathSurface(MIXED);
    const b = pathSurface("`scripts/other.ts`");
    const r = disjointness(a, b);
    expect(r.state).toBe("unproven");
    expect(r.reason).toMatch(/未识别|partial|不完整/);
  });

  test("★ 两个 partial 共享一个**已识别**文件 → 仍报 overlap（已知的冲突不能被 partial 吞掉）", () => {
    const a = pathSurface("`.github/x.yml` 和 `scripts/same.ts`");
    const b = pathSurface("`.github/y.yml` 和 `scripts/same.ts`");
    const r = disjointness(a, b);
    expect(r.state).toBe("overlap");
    expect(r.shared).toEqual(["scripts/same.ts"]);
  });

  test("无任何路径样 token → 仍是 unproven（不是 partial）", () => {
    expect(pathSurface("完全没有路径的正文").state).toBe("unproven");
  });
});

describe("★ 成员不该与自己的 epic 报冲突", () => {
  test("REJECT：候选是该 epic 的成员时，与它的冲突不算冲突", () => {
    expect(isSelfMember(5627, [5627, 5634, 5635])).toBe(true);
  });
  test("ACCEPT：非成员的冲突必须照报", () => {
    expect(isSelfMember(4892, [5627, 5634, 5635])).toBe(false);
  });
  test("空成员表 → 谁都不是成员", () => {
    expect(isSelfMember(1, [])).toBe(false);
  });
});
