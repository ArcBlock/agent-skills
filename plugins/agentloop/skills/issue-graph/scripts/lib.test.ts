import { describe, expect, test } from "bun:test";
import {
  isAgentAuthored,
  isRollupAlreadyReviewed,
  parseOwnerRepoFromGitUrl,
  resolveRepo,
} from "./lib";

describe("parseOwnerRepoFromGitUrl", () => {
  test("ssh url with .git suffix", () => {
    expect(parseOwnerRepoFromGitUrl("git@github.com:ArcBlock/afs.git")).toBe("ArcBlock/afs");
  });

  test("ssh url without .git suffix", () => {
    expect(parseOwnerRepoFromGitUrl("git@github.com:ArcBlock/afs")).toBe("ArcBlock/afs");
  });

  test("https url with .git suffix", () => {
    expect(parseOwnerRepoFromGitUrl("https://github.com/ArcBlock/afs.git")).toBe("ArcBlock/afs");
  });

  test("https url without .git suffix", () => {
    expect(parseOwnerRepoFromGitUrl("https://github.com/ArcBlock/afs")).toBe("ArcBlock/afs");
  });

  test("https url with credentials (proxy-injected token form)", () => {
    expect(parseOwnerRepoFromGitUrl("https://x-access-token:tok@github.com/ArcBlock/afs.git")).toBe(
      "ArcBlock/afs",
    );
  });

  test("ssh:// protocol url", () => {
    expect(parseOwnerRepoFromGitUrl("ssh://git@github.com/ArcBlock/afs.git")).toBe("ArcBlock/afs");
  });

  test("non-github remote returns null", () => {
    expect(parseOwnerRepoFromGitUrl("git@gitlab.com:ArcBlock/afs.git")).toBeNull();
    expect(parseOwnerRepoFromGitUrl("/local/bare/repo.git")).toBeNull();
    expect(parseOwnerRepoFromGitUrl("")).toBeNull();
  });

  test("cloud-session local git proxy url (/git/<owner>/<repo>)", () => {
    expect(parseOwnerRepoFromGitUrl("http://local_proxy@127.0.0.1:41729/git/ArcBlock/arc")).toBe(
      "ArcBlock/arc",
    );
    expect(
      parseOwnerRepoFromGitUrl("http://local_proxy@127.0.0.1:41729/git/ArcBlock/arc.git"),
    ).toBe("ArcBlock/arc");
  });
});

describe("resolveRepo precedence", () => {
  test("explicit arg wins over everything", () => {
    process.env.ISSUE_GRAPH_REPO = "Env/repo";
    try {
      expect(resolveRepo("Explicit/repo")).toBe("Explicit/repo");
    } finally {
      delete process.env.ISSUE_GRAPH_REPO;
    }
  });

  test("ISSUE_GRAPH_REPO wins over git remote", () => {
    process.env.ISSUE_GRAPH_REPO = "Env/repo";
    try {
      expect(resolveRepo()).toBe("Env/repo");
    } finally {
      delete process.env.ISSUE_GRAPH_REPO;
    }
  });

  test("falls back to git remote origin without gh (GraphQL-free path)", () => {
    // This test runs inside the repo checkout, so `git remote get-url origin`
    // must resolve — the whole point of the fix is that this path never
    // shells out to `gh repo view` (GraphQL, blocked by cloud-routine proxy).
    delete process.env.ISSUE_GRAPH_REPO;
    const repo = resolveRepo();
    expect(repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
  });
});

describe("isRollupAlreadyReviewed", () => {
  test("no last comment → not reviewed (fresh candidate)", () => {
    expect(isRollupAlreadyReviewed(null, null, null)).toBe(false);
  });

  test("last comment is human, not an agent verdict → not reviewed", () => {
    expect(
      isRollupAlreadyReviewed(
        "请针对最新代码仓库 review 下这个大任务的完成状态，报告贴在下面。",
        "2026-07-15T13:37:16Z",
        "2026-07-14T21:00:00Z",
      ),
    ).toBe(false);
  });

  test("agent rollup verdict posted AFTER all children closed → already reviewed, skip", () => {
    expect(
      isRollupAlreadyReviewed(
        "> 🤖 AI Agent — 父级 rollup 核对\n\n部分完成，保持 open，不 close。",
        "2026-07-16T17:18:08Z",
        "2026-07-14T21:37:03Z",
      ),
    ).toBe(true);
  });

  test("a child closed AFTER the last verdict comment → new signal, re-surface", () => {
    expect(
      isRollupAlreadyReviewed(
        "> 🤖 AI Agent — 父级 rollup 核对\n\n部分完成，保持 open，不 close。",
        "2026-07-14T21:00:00Z",
        "2026-07-16T17:18:08Z",
      ),
    ).toBe(false);
  });

  test("agent verdict comment but no children-closed timestamp available → treat as reviewed", () => {
    expect(
      isRollupAlreadyReviewed(
        "> 🤖 AI Agent — Rollup 核对\n\n全覆盖，close。",
        "2026-07-16T17:18:08Z",
        null,
      ),
    ).toBe(true);
  });

  test("agent comment present but not a rollup verdict (e.g. unrelated audit note) → not reviewed", () => {
    expect(
      isRollupAlreadyReviewed(
        "> 🤖 AI Agent\n\n这是一条无关的 doc-audit 评论，不涉及 rollup。",
        "2026-07-16T17:18:08Z",
        "2026-07-14T21:00:00Z",
      ),
    ).toBe(false);
  });

  // #1805: 身份行格式的真实 rollup 核对评论（无字面 "🤖 AI Agent"，取自 #378 2026-07-16T17:18:08Z 评论原文）
  // 曾被窄正则误判为"未复核"，导致同一 partial-rollup 结论被反复重新核对。
  test("identity-line rollup verdict with sweep-trace + Generated-by footer, no literal 🤖 AI Agent → already reviewed (#378/#1805)", () => {
    const realComment = `@ vm · runner:robert · skills@19dfc2bc

## 父级 rollup 核对（issue-graph 检测到全部已知子 issue 已关闭）

子 issue 覆盖情况：
- #1552 clipboard provider —— iOS + Android → **closed**
- #1553 file-picker provider —— iOS + Android → **closed**

对照本 issue 表格中的完整类目清单：clipboard、file-picker、sensors/运动、bluetooth、NFC、telephony/SMS 共 6 项。目前只有 clipboard、file-picker 两项被 promote 成了子 issue 并已完成；**sensors / bluetooth / NFC / telephony 四项尚未被 promote，仍是待拆分的 backlog 条目**，不存在对应子 issue（不是"未完成"，是"还没拆出来"）。

**结论：不是全覆盖 rollup，是 umbrella backlog 的部分完成。** 保持 open，按 \`agent:ready\` 继续逐项按需 promote 剩余 4 项。

<!-- sweep-trace: {"ver":1,"issue":378,"gate":"disposition","val":"comment","run":"2026-07-16T17:18:03Z","runner":"robert","skills":"19dfc2bc"} -->


---
_Generated by [Claude Code](https://claude.ai/code)_`;
    expect(
      isRollupAlreadyReviewed(realComment, "2026-07-16T17:18:08Z", "2026-07-14T21:00:00Z"),
    ).toBe(true);
  });
});

describe("isAgentAuthored", () => {
  test("🤖 AI Agent literal in head → agent", () => {
    expect(isAgentAuthored("> 🤖 AI Agent — 父级 rollup 核对\n\n内容")).toBe(true);
  });

  test("identity-line header with no literal 🤖 AI Agent, but sweep-trace marker → agent", () => {
    expect(
      isAgentAuthored(
        "@ vm · runner:robert · skills@19dfc2bc\n\n## 结论\n\n正文\n\n<!-- sweep-trace: {} -->",
      ),
    ).toBe(true);
  });

  test("no marker anywhere, ends with Generated-by footer → agent", () => {
    expect(
      isAgentAuthored("普通结论文字\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_"),
    ).toBe(true);
  });

  test("plain human reply with no markers → not agent", () => {
    expect(isAgentAuthored("同意，麻烦发 PR。")).toBe(false);
  });

  test("🤖 emoji appears only deep in body (not first 3 lines) with no other marker → not agent", () => {
    expect(isAgentAuthored("line1\nline2\nline3\nline4\n🤖 mentioned way down here")).toBe(false);
  });
});
