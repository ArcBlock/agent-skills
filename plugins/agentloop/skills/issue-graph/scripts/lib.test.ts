import { describe, expect, test } from "bun:test";
import { parseOwnerRepoFromGitUrl, resolveRepo } from "./lib";

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
