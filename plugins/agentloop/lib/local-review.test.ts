import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { requireStickyGate } from "./gate";
import {
  agentAuthored,
  assertReviewerEngine,
  attestLocalReview,
  type Convergence,
  coderEngineClaim,
  convergence,
  crossEngineVerdict,
  type Disposition,
  LOCAL_REVIEW_PREFIX,
  localReviewRerunHint,
  nextRound,
  nextRoundState,
  parseCodexReview,
  parsePriorDispositions,
  parseReviewerEngineFromComment,
  parseReviewReport,
  parseReviewState,
  pickDefaultReviewer,
  REPORT_CONTRACT,
  type ReviewFinding,
  ROUND_CAP,
  renderReviewComment,
  requireLocalReviewSticky,
  resolveReviewerBin,
  resolveSubjectEngine,
  reviewerArgv,
  reviewerEngines,
  reviewResult,
  reviewResultForRound,
  roundPrompt,
  type StateFinding,
  setReviewerEngines,
  toStateFindings,
} from "./local-review";

/** 真实产物：2026-08-31 本地 codex 对 arc#5685 的 review，逐字保存。 */
const REAL = readFileSync(new URL("./fixtures/codex-review-5685.txt", import.meta.url), "utf8");

/** 插件自带**空表**。测试注入一份 fixture —— 引擎的值属于消费仓库，不属于插件。 */
const FIXTURE = {
  alpha: {
    bin: "alpha",
    args: ({ prompt, base, outFile }: { prompt: string; base: string; outFile?: string }) => [
      "review",
      "--base",
      base,
      "--read-only",
      ...(outFile ? ["-o", outFile] : []),
      prompt,
    ],
    outputMode: "file" as const,
  },
  beta: {
    bin: "beta",
    args: ({ prompt }: { prompt: string; base: string }) => [
      "-p",
      prompt,
      "--allowed-tools",
      "Read",
    ],
    outputMode: "stdout" as const,
  },
  // 既有用例用这些名字当 coder/reviewer；注册表是 canonicalize 的对照，不在表里
  // 的拼写必须 BLOCKED（#5697 f1kdxa2v），所以它们得是真的注册项，不是随便两个字符串。
  codex: {
    bin: "codex",
    args: ({ prompt }: { prompt: string; base: string }) => ["-p", prompt],
    outputMode: "stdout" as const,
  },
  claude: {
    bin: "claude",
    args: ({ prompt }: { prompt: string; base: string }) => ["-p", prompt],
    outputMode: "stdout" as const,
  },
  grok: {
    bin: "grok",
    args: ({ prompt }: { prompt: string; base: string }) => ["-p", prompt],
    outputMode: "stdout" as const,
  },
};
setReviewerEngines(FIXTURE);
beforeEach(() => setReviewerEngines(FIXTURE));

describe("reviewerArgv —— 引擎不写死，未声明的引擎必须拒绝", () => {
  test("argv 以 bin 开头，参数来自注入的表", () => {
    const argv = reviewerArgv("alpha", { prompt: "<P>", base: "origin/main" });
    expect(argv[0]).toBe("alpha");
    expect(argv.join(" ")).toContain("--base origin/main");
    expect(argv).toContain("<P>");
  });

  test("★ 表是空的也要抛错 —— 「没有注册任何引擎」不得静静变成放行", () => {
    setReviewerEngines({});
    expect(() => reviewerArgv("alpha", { prompt: "x", base: "main" })).toThrow(/no reviewer/i);
    setReviewerEngines(FIXTURE);
  });

  test("★ 未声明的引擎 → 抛错，不猜、不默认回 codex", () => {
    // 「不写死 codex」的正确实现是**注册表**，不是「认不出就当 codex」。
    expect(() => reviewerArgv("gemini", { prompt: "x", base: "main" })).toThrow(/not registered/i);
    expect(() => assertReviewerEngine("gemini")).toThrow(/not registered/i);
  });

  test("ACCEPT：已注册的引擎不抛（否则「全拒」满足上面每一条）", () => {
    expect(() => assertReviewerEngine("alpha")).not.toThrow();
  });
});

describe("★ crossEngineVerdict —— reviewer.engine ≠ coder.engine 是硬不变量", () => {
  test("ACCEPT：跨引擎放行", () => {
    // 这条是 accept 臂。缺了它，一个「永远返回 not-ok」的实现满足下面全部 reject 断言。
    expect(crossEngineVerdict("codex", "claude")).toMatchObject({ ok: true });
    expect(crossEngineVerdict("claude", "codex")).toMatchObject({ ok: true });
    expect(crossEngineVerdict("grok", "claude")).toMatchObject({ ok: true });
  });

  test("同引擎不放行，且理由说得出是哪一条", () => {
    const v = crossEngineVerdict("codex", "codex");
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("same-engine");
  });

  test("★ 缺 subjectEngine = 未知，不得当成独立（#5352）", () => {
    // 「不知道」与「已证明跨引擎」不许同色——这正是 #5352 立的规矩。
    expect(crossEngineVerdict("codex", undefined)).toMatchObject({ ok: false, reason: "unknown" });
    expect(crossEngineVerdict(undefined, "claude")).toMatchObject({ ok: false, reason: "unknown" });
    expect(crossEngineVerdict("", "")).toMatchObject({ ok: false, reason: "unknown" });
  });

  test("★ 判据只看引擎，不看 agent id —— 同引擎的两个不同 agent 仍然不算独立", () => {
    expect(crossEngineVerdict("codex", "codex").ok).toBe(false);
  });

  test("★ 未注册的拼写不得被读成跨引擎（#5697 f1kdxa2v）", () => {
    // `codxe` 与 `codex` 是两个不同字符串，旧实现因此给出 cross-engine PASS。
    // 未注册的名字是「不知道」，不是「不同类型」。
    expect(crossEngineVerdict("codxe", "codex")).toMatchObject({ ok: false, reason: "unknown" });
    expect(crossEngineVerdict("codex", "codxe")).toMatchObject({ ok: false, reason: "unknown" });
    expect(crossEngineVerdict("gemini", "claude")).toMatchObject({ ok: false, reason: "unknown" });
  });

  test("ACCEPT：大小写折叠到注册表 id 之后仍跨引擎（否则只认小写会把真引擎挡死）", () => {
    expect(crossEngineVerdict("Codex", "Claude")).toMatchObject({
      ok: true,
      reason: "cross-engine",
    });
  });
});

describe("parseCodexReview —— 拿真实产物解析，不是照着格式编一份", () => {
  test("★ 真实输出里的两条 P2 都解析出来，文件与行号对得上", () => {
    const r = parseCodexReview(REAL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings.length).toBe(2);
    expect(r.findings[0]).toMatchObject({
      severity: "P2",
      file: "/Users/robmao/work/arcblock/arc/.claude/plugins/agentloop/skills/issue-sweep-batch/scripts/html.ts",
      line: "346-348",
    });
    expect(r.findings[1]).toMatchObject({
      severity: "P2",
      file: "/Users/robmao/work/arcblock/arc/.claude/plugins/agentloop/skills/issue-sweep-batch/scripts/ui-verify.mjs",
      line: "183-186",
    });
    expect(r.findings[0].title).toContain("symptom");
    expect(r.findings[0].body.length).toBeGreaterThan(40);
  });

  test("★ 绝对路径要收成仓库相对路径（否则贴到 PR 上没人点得开）", () => {
    const r = parseCodexReview(REAL, { repoRoot: "/Users/robmao/work/arcblock/arc" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const f of r.findings) expect(f.file.startsWith("/")).toBe(false);
  });

  test("★ 「零条 finding」与「解析器没看懂」必须不同色", () => {
    // 度量正控：一个看不懂输出的解析器返回 [] ，与一次干净的 review 完全同色，
    // 而干净是那个会放行合并的答案。所以不认识的形状一律 unparseable，不是 0 条。
    expect(parseCodexReview("总之我觉得还行").ok).toBe(false);
    expect(parseCodexReview("").ok).toBe(false);
    const clean = parseCodexReview("Looks good.\n\nFull review comments:\n\n(none)");
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.findings.length).toBe(0);
    // ★ 第三次变形（codex 审 #5697 报的 P1）：小节头之后**什么都没有**。
    //   截断的响应、或只打了标题就退出的 reviewer，与「审完了、干净」同色。
    //   零条必须要有明确的哨兵，不能靠「没看见别的东西」推出来。
    expect(parseCodexReview("Summary\n\nFull review comments:\n").ok).toBe(false);
    expect(parseCodexReview("Summary\n\nFull review comments:").ok).toBe(false);
  });
});

describe("★ reviewResult —— 独立性编进 result，第五道门因此不需要新逻辑", () => {
  const none: never[] = [];
  const two = [{ severity: "P2", title: "t", file: "a.ts", body: "b" }];

  test("ACCEPT：跨引擎 + 零 finding → PASS（唯一可合并的组合）", () => {
    expect(reviewResult({ reviewerEngine: "codex", subjectEngine: "claude", findings: none })).toBe(
      "PASS",
    );
  });

  test("跨引擎但有 finding → FAIL", () => {
    expect(reviewResult({ reviewerEngine: "codex", subjectEngine: "claude", findings: two })).toBe(
      "FAIL",
    );
  });

  test("★ 同引擎 → BLOCKED，即使一条 finding 都没有", () => {
    // 独立性不成立时，「没发现问题」不构成证据——这正是 BLOCKED 与 PASS 的区别：
    // 闸跑了，但要求的证据没能成立。
    expect(reviewResult({ reviewerEngine: "codex", subjectEngine: "codex", findings: none })).toBe(
      "BLOCKED",
    );
  });

  test("★ 独立性未知 → BLOCKED，不得因为「没报问题」而放行", () => {
    expect(
      reviewResult({ reviewerEngine: "codex", subjectEngine: undefined, findings: none }),
    ).toBe("BLOCKED");
  });

  test("★ 解析失败 → BLOCKED，不是 PASS", () => {
    // 「解析器没看懂」绝不能走成「没发现问题」。
    expect(
      reviewResult({ reviewerEngine: "codex", subjectEngine: "claude", unparseable: true }),
    ).toBe("BLOCKED");
  });
});

describe("★ sticky comment —— 复用仓库既有的 gate 原语，不另造一套格式", () => {
  const SHA = "3fa00a72841e15a377c36cb5e3c8a092a6d3fd93";
  const render = (reviewerEngine: string, subjectEngine: string | undefined) =>
    renderReviewComment({
      reviewerEngine,
      subjectEngine,
      sha: SHA,
      base: "origin/main",
      findings: (() => {
        const r = parseCodexReview(REAL);
        return r.ok ? r.findings : [];
      })(),
    });

  /** 只把被测的那条评论喂给闸；闸自己走 gh，这里注入替身。 */
  // Runner 的形状是 { code, out, ms } —— 少给 ms 在 bun test 下照样跑，但 tsc 会红。
  // 这类「测试替身与真实签名不符」正是 #5704 想让闸看见的东西。
  const runnerWith = (body: string) => () => ({ code: 0, out: JSON.stringify({ body }), ms: 0 });

  test("marker 必须在第 1 行且带 sha= / result=（闸按前缀 startswith 找它）", () => {
    const first = render("codex", "claude").split("\n")[0];
    expect(first.startsWith(LOCAL_REVIEW_PREFIX)).toBe(true);
    expect(first).toContain(`sha=${SHA}`);
    expect(first).toContain("result=");
  });

  test("★ 同引擎的评论被既有闸原样挡下 —— 第五道门零新逻辑", () => {
    const gate = requireStickyGate(
      "5685",
      SHA,
      LOCAL_REVIEW_PREFIX,
      "local review",
      "hint",
      runnerWith(render("codex", "codex")),
    );
    expect(gate.ok).toBe(false);
  });

  test("★ ACCEPT：跨引擎 + 无 finding 的评论被同一道闸放行", () => {
    // 这条是 accept 臂。缺了它，一道「全挡」的闸满足上面每一条断言。
    const clean = renderReviewComment({
      reviewerEngine: "codex",
      subjectEngine: "claude",
      sha: SHA,
      base: "origin/main",
      findings: [],
    });
    const gate = requireStickyGate(
      "5685",
      SHA,
      LOCAL_REVIEW_PREFIX,
      "local review",
      "hint",
      runnerWith(clean),
    );
    expect(gate.ok).toBe(true);
  });

  test("★ sha 不匹配 HEAD 时挡下 —— 旧 SHA 的 review 不是本次的证据", () => {
    const gate = requireStickyGate(
      "5685",
      "0000000000000000000000000000000000000000",
      LOCAL_REVIEW_PREFIX,
      "local review",
      "hint",
      runnerWith(render("codex", "claude")),
    );
    expect(gate.ok).toBe(false);
  });

  test("正文里人也看得见两条 finding 的落点与独立性", () => {
    const body = render("codex", "claude");
    expect(body).toContain("html.ts");
    expect(body).toContain("ui-verify.mjs");
    expect(body).toContain("P2");
    expect(body).toContain("cross-engine");
  });
});

describe("★ agentAuthored —— 第五道门只对 agent 写的 PR 生效", () => {
  const line =
    "> 🤖 AI Agent PR @ host · runner:Robert Mao · agentloop@0.35.0+abc · skill:x · engine:claude";

  test("ACCEPT：带身份行且声明了引擎 → 要求跨引擎 review", () => {
    expect(agentAuthored(`${line}\n\n正文`)).toMatchObject({
      required: true,
      coderEngine: "claude",
    });
  });

  test("★ 人写的 PR 不受这道门管（否则它会把每一条人类 PR 一起挡死）", () => {
    // 一道从第一天就挡住一切的门是「一个没人能动的数字」。判据必须真的能分辨。
    expect(agentAuthored("修了个 typo\n\nfixes #1")).toMatchObject({ required: false });
    expect(agentAuthored("")).toMatchObject({ required: false });
  });

  test("★ 有身份行但没声明引擎 → 仍然要求，且 coderEngine 未知", () => {
    // 「认不出 coder 引擎」不是放行的理由——放行会让一条去掉 engine 字段的身份行
    // 成为绕过这道门的办法。
    const noEngine = "> 🤖 AI Agent PR @ host · runner:x · agentloop@0.35.0+abc · skill:x";
    const r = agentAuthored(noEngine);
    expect(r.required).toBe(true);
    expect(r.coderEngine).toBeUndefined();
  });

  test("★ 只是正文里提到 engine: 不算身份行", () => {
    expect(agentAuthored("我们讨论一下 engine:claude 的问题")).toMatchObject({ required: false });
  });
});

describe("★ 解析器的 fail-closed 是逐行的，不只是「有没有那一节」", () => {
  // 本地 codex 审这套代码时自己报的 P2：只要 `Full review comments:` 在，
  // 后面每一行都匹配不上 FINDING_RE 也会返回 ok+0 条 —— 而 0 条会走成 PASS。
  // 「解析器没看懂」与「审过了、干净」又一次同色，只是这次躲在小节内部。
  test("★ 小节里有实质内容但一条都解析不出 → unparseable，不是 0 条", () => {
    const drifted =
      "Summary\n\nFull review comments:\n\n" +
      "* [P2] 换了个符号的 finding — some/file.ts:12\n" +
      "* [P1] 又一条 — other/file.ts:44\n";
    expect(parseCodexReview(drifted).ok).toBe(false);
  });

  test("★ ACCEPT：真干净的一轮仍然是 ok + 0 条（否则「全拒」满足上一条）", () => {
    expect(parseCodexReview("Summary\n\nFull review comments:\n\n(none)")).toMatchObject({
      ok: true,
      findings: [],
    });
    expect(parseCodexReview("Summary\n\nFull review comments:\n\nnone").ok).toBe(true);
  });

  test("ACCEPT：认得出的一条 + 后面的续行正文，仍然是 ok", () => {
    const r = parseCodexReview(REAL);
    expect(r.ok).toBe(true);
  });
});

describe("★ 仓库根从调用方来，不靠猜路径里有没有 /arc/", () => {
  // 同上，也是本地 codex 报的：写死 `/arc/` 在别的仓库、别的 checkout 名下就失灵。
  const ROOT = "/Users/robmao/work/arcblock/arc";

  test("给了根就按根去掉前缀", () => {
    const r = parseCodexReview(REAL, { repoRoot: ROOT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings[0].file).toBe(
      ".claude/plugins/agentloop/skills/issue-sweep-batch/scripts/html.ts",
    );
  });

  test("★ 没给根就**保持原样**，不假装转换成功", () => {
    const r = parseCodexReview("x\n\nFull review comments:\n\n- [P2] t — /some/abs/path.ts:1\n");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings[0].file).toBe("/some/abs/path.ts");
  });

  test("★ 根之外的路径不被误剪", () => {
    const r = parseCodexReview("x\n\nFull review comments:\n\n- [P2] t — /elsewhere/a.ts:1\n", {
      repoRoot: ROOT,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings[0].file).toBe("/elsewhere/a.ts");
  });
});

describe("★ 交付面的硬上限 —— 端到端才暴露的那个 bug", () => {
  // 真实事故：第一次带 --post 跑，GitHub 返回 422「Body is too long (maximum is
  // 65536 characters)」。根因是解析器把 codex 的**事件流**（verbose 日志）也当成
  // finding 正文一路吞了。两道都要补：只解析 review 正文，且交付面有硬上限。
  test("★ reviewerArgv 支持 -o：只拿最后一条消息，不解析事件流", () => {
    const argv = reviewerArgv("alpha", { prompt: "<P>", base: "main", outFile: "/tmp/x.md" });
    expect(argv).toContain("-o");
    expect(argv[argv.indexOf("-o") + 1]).toBe("/tmp/x.md");
  });

  test("★ 单条 finding 正文有上限，且截断要说出来", () => {
    const huge = "x".repeat(20_000);
    const r = parseCodexReview(`s\n\nFull review comments:\n\n- [P2] t — /a.ts:1\n  ${huge}\n`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings[0].body.length).toBeLessThan(2000);
    expect(r.findings[0].body).toContain("截断");
  });

  test("★ 整条评论不超过 GitHub 的 65536，且超了要说出来而不是悄悄丢", () => {
    const many = Array.from({ length: 400 }, (_, k) => ({
      severity: "P2",
      title: `finding ${k}`,
      file: `file-${k}.ts`,
      line: "1",
      body: "y".repeat(1000),
    }));
    const body = renderReviewComment({
      reviewerEngine: "codex",
      subjectEngine: "claude",
      sha: "a".repeat(40),
      base: "origin/main",
      findings: many,
    });
    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body).toContain("条未展开");
    // marker 必须活下来 —— 它是闸唯一读的东西，截断绝不能把它切掉。
    expect(body.split("\n")[0].startsWith(LOCAL_REVIEW_PREFIX)).toBe(true);
    expect(body).toContain("result=FAIL");
  });

  test("★ ACCEPT：正常大小的评论一个字不删", () => {
    const body = renderReviewComment({
      reviewerEngine: "codex",
      subjectEngine: "claude",
      sha: "a".repeat(40),
      base: "origin/main",
      findings: (() => {
        const r = parseCodexReview(REAL, { repoRoot: "/Users/robmao/work/arcblock/arc" });
        return r.ok ? r.findings : [];
      })(),
    });
    expect(body).not.toContain("条未展开");
    expect(body).toContain("ui-verify.mjs");
  });
});

describe("★ subjectEngine 必须取自 PR 记录，不接受与之矛盾的覆盖", () => {
  // 本地跨引擎 review 审这条 PR 时报的 P1：`--subject-engine` 优先于 PR 正文里
  // 记录的引擎，于是一个 codex 作者可以用 codex reviewer 加 `--subject-engine claude`
  // 造出一个 PASS marker —— **闸自己的绕过口**。
  const claudePr = "> 🤖 AI Agent PR @ h · runner:x · agentloop@0.36.0+a · skill:x · engine:claude";

  test("ACCEPT：没给覆盖时用 PR 记录的引擎", () => {
    expect(resolveSubjectEngine(claudePr, undefined)).toMatchObject({
      ok: true,
      engine: "claude",
    });
  });

  test("ACCEPT：覆盖与记录一致时放行（否则「全拒」满足下面每一条）", () => {
    expect(resolveSubjectEngine(claudePr, "claude")).toMatchObject({ ok: true, engine: "claude" });
  });

  test("★ 覆盖与记录矛盾 → 拒绝，不是取覆盖", () => {
    const r = resolveSubjectEngine(claudePr, "codex");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("claude");
    expect(r.reason).toContain("codex");
  });

  test("★ PR 没记录引擎时，覆盖也不算数 —— 无从核对就不是证据", () => {
    const noEngine = "> 🤖 AI Agent PR @ h · runner:x · agentloop@0.36.0+a · skill:x";
    expect(resolveSubjectEngine(noEngine, "claude").ok).toBe(false);
  });

  test("★ 完全拿不到 PR 正文时也不接受覆盖（离线不得成为绕过口）", () => {
    expect(resolveSubjectEngine(undefined, "claude").ok).toBe(false);
  });
});

describe("★ 每个 coder 引擎都必须有人能审它 —— 否则这道门对它就是一堵墙", () => {
  // 本地跨引擎 review 审这道门自己时报的 P1：注册表里只有 codex，于是 codex 写的
  // PR 恒 BLOCKED，而传 --engine claude 会抛「未注册」——**没有任何一条命令能为它
  // 产出所需的 PASS**。这正是「一道从第一天就挡住一切的门是一个没人能动的数字」。
  test("★ 注册表里至少两个引擎（一个引擎的注册表让这道门不可满足）", () => {
    expect(Object.keys(reviewerEngines()).length).toBeGreaterThanOrEqual(2);
  });

  test("★ 对每个已注册引擎，都存在一个能审它的**不同**引擎", () => {
    const ids = Object.keys(reviewerEngines());
    for (const coder of ids) {
      const reviewers = ids.filter((r) => crossEngineVerdict(r, coder).ok);
      expect(reviewers.length).toBeGreaterThan(0);
    }
  });

  test("★ 每个引擎都声明了怎么被无头调用、怎么拿输出、怎么解析", () => {
    for (const [id, e] of Object.entries(reviewerEngines())) {
      const argv = e.args({ prompt: "<P>", base: "origin/main", outFile: "/tmp/o.md" });
      expect(argv.length).toBeGreaterThan(1);
      expect(["file", "stdout"]).toContain(e.outputMode);
      expect(e.bin.length).toBeGreaterThan(0);
      expect(id.length).toBeGreaterThan(0);
    }
  });

  test("★ 解析器只有一个 —— 报告格式是共用契约，不按引擎分叉", () => {
    const report = "s\n\nFull review comments:\n\n- [P2] t — /a/b.ts:3\n  正文\n";
    const r = parseReviewReport(report);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.findings.length).toBe(1);
    // 契约里必须写明零条要哨兵 —— 否则「被截断」与「干净」在产出侧就同色了。
    expect(REPORT_CONTRACT).toContain("(none)");
  });
});

describe("★ `unknown` 是缺席，不是一个引擎名", () => {
  // claude 审这道门时报的 P1：`agent-identity.sh` 在解析不出引擎时输出的是字面量
  // `engine:unknown`。而 crossEngineVerdict("codex","unknown") 曾返回 cross-engine，
  // 于是 **codex 审 codex 的 PR 会拿到 PASS**——和刚堵掉的 --subject-engine 同一个
  // 绕过口，但**不需要任何标志**，只要 coder 那次会话没设那个环境变量。
  test("★ 任一侧是 unknown → 不放行", () => {
    expect(crossEngineVerdict("codex", "unknown")).toMatchObject({ ok: false, reason: "unknown" });
    expect(crossEngineVerdict("unknown", "claude")).toMatchObject({ ok: false, reason: "unknown" });
    expect(crossEngineVerdict("unknown", "unknown")).toMatchObject({
      ok: false,
      reason: "unknown",
    });
  });

  test("★ 身份行写 engine:unknown 时，coderEngine 视为缺席", () => {
    const body = "> 🤖 AI Agent PR @ h · runner:x · agentloop@0.36.0+a · skill:x · engine:unknown";
    const a = agentAuthored(body);
    expect(a.required).toBe(true); // 仍然是 agent 写的，门仍然要求
    expect(a.coderEngine).toBeUndefined(); // 但引擎未知，判决落到 BLOCKED
  });

  test("★ engine:unknown 不能当成 subjectEngine 的记录值", () => {
    const body = "> 🤖 AI Agent PR @ h · runner:x · agentloop@0.36.0+a · skill:x · engine:unknown";
    expect(resolveSubjectEngine(body, "claude").ok).toBe(false);
  });

  test("ACCEPT：真引擎名照常放行（否则「全拒」满足上面每一条）", () => {
    expect(crossEngineVerdict("codex", "claude").ok).toBe(true);
    const real = "> 🤖 AI Agent PR @ h · runner:x · agentloop@0.36.0+a · skill:x · engine:codex";
    expect(agentAuthored(real).coderEngine).toBe("codex");
  });
});

describe("★ 轮次与收敛 —— 不限轮次的 reviewer 会漂移，不会收敛", () => {
  const f = (id: string, sev: string, file: string): ReviewFinding & { id: string } => ({
    id,
    severity: sev,
    title: `t-${id}`,
    file,
    line: "1",
    body: "b",
  });
  const prior = [f("a1", "P2", "x.ts"), f("a2", "P1", "y.ts")];

  test("★ 轮次账本就是那条 sticky comment，不另建存储", () => {
    const body = renderReviewComment({
      reviewerEngine: "codex",
      subjectEngine: "claude",
      sha: "a".repeat(40),
      base: "origin/main",
      findings: prior,
      round: 2,
    });
    const st = parseReviewState(body);
    expect(st?.round).toBe(2);
    expect(st?.findings.map((x) => x.id)).toEqual(["a1", "a2"]);
  });

  test("★ 没有 state 的评论读成 undefined —— 下一轮据此从第 1 轮起", () => {
    expect(parseReviewState("随便一条人类评论")).toBeUndefined();
    expect(nextRound(undefined)).toBe(1);
    expect(nextRound({ round: 2, findings: prior })).toBe(3);
  });

  test("★ 第 1 轮广撒网，第 N 轮的提示词以逐条判定上一轮为主", () => {
    expect(roundPrompt(1, [])).toContain("广");
    const p2 = roundPrompt(2, prior);
    expect(p2).toContain("a1");
    expect(p2).toContain("a2");
    expect(p2).toContain("Prior findings:");
    // 新问题只报 P1 —— 这正是防漂移那一条
    expect(p2).toContain("P1");
  });

  test("★★ 静默不算收敛：漏判上一轮任何一条 → 未收敛", () => {
    // 不写死这条，reviewer 可以靠「这轮没话说」假装收敛 ——
    // 「审完了没事」与「它没看」又一次同色。
    const c = convergence(prior, new Map([["a1", "fixed"]]), []);
    expect(c.converged).toBe(false);
    expect(c.unadjudicated).toEqual(["a2"]);
  });

  test("★ ACCEPT：上一轮全部 fixed 且无新 P1 → 收敛（否则「永不收敛」满足其余每一条）", () => {
    const c = convergence(
      prior,
      new Map([
        ["a1", "fixed"],
        ["a2", "fixed"],
      ]),
      [],
    );
    expect(c.converged).toBe(true);
    expect(c.unadjudicated).toEqual([]);
  });

  test("还有 open 或 regressed → 未收敛，且说得出是哪几条", () => {
    const c = convergence(
      prior,
      new Map([
        ["a1", "open"],
        ["a2", "regressed"],
      ]),
      [],
    );
    expect(c.converged).toBe(false);
    expect(c.open).toEqual(["a1"]);
    expect(c.regressed).toEqual(["a2"]);
  });

  test("★ 新的 P1 打断收敛；新的 P2/P3 记为 deferred，不打断", () => {
    const done = new Map([
      ["a1", "fixed"],
      ["a2", "fixed"],
    ] as const);
    const withP2 = convergence(prior, new Map(done), [f("n1", "P2", "z.ts")]);
    expect(withP2.converged).toBe(true);
    expect(withP2.deferred).toEqual(["n1"]);

    const withP1 = convergence(prior, new Map(done), [f("n2", "P1", "z.ts")]);
    expect(withP1.converged).toBe(false);
    expect(withP1.newP1).toEqual(["n2"]);
  });

  test("★ 轮次上限：到顶仍未收敛 → BLOCKED，且要人介入", () => {
    expect(ROUND_CAP).toBe(3);
    const r = reviewResultForRound({
      reviewerEngine: "codex",
      subjectEngine: "claude",
      round: ROUND_CAP + 1,
      findings: [],
      convergence: {
        converged: false,
        unadjudicated: ["a1"],
        open: [],
        regressed: [],
        newP1: [],
        deferred: [],
      },
    });
    expect(r.result).toBe("BLOCKED");
    expect(r.escalate).toBe(true);
  });

  test("★ 第 N 轮的 PASS 必须由收敛证明，不是「这轮没报东西」", () => {
    const notConverged = reviewResultForRound({
      reviewerEngine: "codex",
      subjectEngine: "claude",
      round: 2,
      findings: [],
      convergence: {
        converged: false,
        unadjudicated: ["a1"],
        open: [],
        regressed: [],
        newP1: [],
        deferred: [],
      },
    });
    expect(notConverged.result).toBe("BLOCKED");

    const converged = reviewResultForRound({
      reviewerEngine: "codex",
      subjectEngine: "claude",
      round: 2,
      findings: [],
      convergence: {
        converged: true,
        unadjudicated: [],
        open: [],
        regressed: [],
        newP1: [],
        deferred: [],
      },
    });
    expect(converged.result).toBe("PASS");
  });

  test("★ 第 1 轮没有上一轮可判 —— 收敛不适用，判决同旧逻辑", () => {
    expect(
      reviewResultForRound({
        reviewerEngine: "codex",
        subjectEngine: "claude",
        round: 1,
        findings: [],
      }).result,
    ).toBe("PASS");
    expect(
      reviewResultForRound({
        reviewerEngine: "codex",
        subjectEngine: "claude",
        round: 1,
        findings: prior,
      }).result,
    ).toBe("FAIL");
  });

  test("★ 判定表从报告里解析出来，格式是契约的一部分", () => {
    const report = [
      "总结",
      "",
      "Prior findings:",
      "- [fixed] a1 修好了",
      "- [open] a2 还没动",
      "",
      "Full review comments:",
      "",
      "(none)",
    ].join("\n");
    const d = parsePriorDispositions(report);
    expect(d.get("a1")).toBe("fixed");
    expect(d.get("a2")).toBe("open");
  });
});

describe("★★ marker 的 result 必须是**收敛判决**，不是另算一份", () => {
  // grok 审这一轮时报的 P1：renderReviewComment 用 reviewResult（只看跨引擎+零
  // finding）算 marker，而收敛判决在 reviewResultForRound。两个真相源，**而闸只读
  // marker** —— 第 2 轮未收敛会被写成 result=PASS 放行。
  const notConverged = {
    converged: false,
    unadjudicated: ["a1"],
    open: [],
    regressed: [],
    newP1: [],
    deferred: [],
  };

  test("★ 第 2 轮未收敛、零 finding → marker 必须是 BLOCKED", () => {
    const body = renderReviewComment({
      reviewerEngine: "codex",
      subjectEngine: "claude",
      sha: "a".repeat(40),
      base: "origin/main",
      findings: [],
      round: 2,
      convergence: notConverged,
    });
    expect(body.split("\n")[0]).toContain("result=BLOCKED");
    expect(body.split("\n")[0]).not.toContain("result=PASS");
  });

  test("★ ACCEPT：第 2 轮已收敛 → marker 是 PASS（否则「永远 BLOCKED」满足上一条）", () => {
    const body = renderReviewComment({
      reviewerEngine: "codex",
      subjectEngine: "claude",
      sha: "a".repeat(40),
      base: "origin/main",
      findings: [],
      round: 2,
      convergence: {
        converged: true,
        unadjudicated: [],
        open: [],
        regressed: [],
        newP1: [],
        deferred: [],
      },
    });
    expect(body.split("\n")[0]).toContain("result=PASS");
  });

  test("★ 轮次 state 也算进 65536 —— 生产路径每次都带 round", () => {
    const many = Array.from({ length: 300 }, (_, k) => ({
      severity: "P2",
      title: `finding ${k}`,
      file: `file-${k}.ts`,
      line: "1",
      body: "y".repeat(400),
    }));
    const body = renderReviewComment({
      reviewerEngine: "codex",
      subjectEngine: "claude",
      sha: "a".repeat(40),
      base: "origin/main",
      findings: many,
      round: 2,
    });
    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body.split("\n")[0]).toContain("result=");
  });

  test("★ 哨兵之后的认不出内容仍然算「没看懂」 —— unclaimed 必须参与判决", () => {
    // 注释说靠 unclaimed 把「没看懂」和「干净」分开，但返回条件只看哨兵。
    const r = parseReviewReport(
      "s\n\nFull review comments:\n\n(none)\n* [P1] 格式漂了的一条 — a.ts:1\n",
    );
    expect(r.ok).toBe(false);
  });
});

describe("★★ coder 引擎的来源：工厂写的凭据 vs 被审者写的声明（#5700）", () => {
  const body = (e?: string) =>
    `> 🤖 AI Agent PR @ h · runner:x · agentloop@0.36.0+a · skill:x${e ? ` · engine:${e}` : ""}`;

  test("★ 有 run 记录时以它为准，并标记为 attested", () => {
    // run 记录由 **worker** 在派工时写下（worktreeOwner.branch ↔ engine），
    // 被审的 agent 改不到它。PR 正文它一条 `gh pr edit` 就能改。
    const c = coderEngineClaim("codex", body("codex"));
    expect(c).toMatchObject({ engine: "codex", source: "run-record", attested: true });
  });

  test("★★ 两个来源矛盾 → 硬拦，这是伪造信号本身", () => {
    // run 记录说 codex、正文说 claude：有人改过正文。这不是「以哪个为准」的问题，
    // 是**证据被动过**，必须响亮地失败。
    const c = coderEngineClaim("codex", body("claude"));
    expect(c.attested).toBe(false);
    expect(c.conflict).toEqual({ attested: "codex", claimed: "claude" });
    expect(c.engine).toBeUndefined();
  });

  test("★ 没有 run 记录 → 退回正文，但**标记为未经证实**", () => {
    // 工厂只能对自己派出去的活强制。别处来的 PR 它不知道——如实说「claimed」，
    // 不假装 attested。
    const c = coderEngineClaim(undefined, body("claude"));
    expect(c).toMatchObject({ engine: "claude", source: "pr-body", attested: false });
  });

  test("★ 两边都没有 → 无从核对", () => {
    expect(coderEngineClaim(undefined, body()).engine).toBeUndefined();
    expect(coderEngineClaim(undefined, undefined).engine).toBeUndefined();
  });

  test("★ run 记录里的 engine:unknown 同样是缺席，不是一个引擎名", () => {
    expect(coderEngineClaim("unknown", body("claude"))).toMatchObject({
      engine: "claude",
      source: "pr-body",
      attested: false,
    });
  });

  test("★ ACCEPT：只有 run 记录、正文没身份行 → 仍然 attested（正文不是必需品）", () => {
    expect(coderEngineClaim("grok-build", "普通 PR 正文")).toMatchObject({
      engine: "grok-build",
      source: "run-record",
      attested: true,
    });
  });
});

describe("★★ 未了结的 finding 必须被带进下一轮账本（#5697 review P1）", () => {
  const prior: StateFinding[] = [
    { id: "aaa", severity: "P1", title: "还没修", file: "a.ts", line: "1" },
    { id: "bbb", severity: "P2", title: "修好了", file: "b.ts", line: "2" },
  ];
  const conv = (over: Partial<Convergence>): Convergence => ({
    converged: false,
    unadjudicated: [],
    open: [],
    regressed: [],
    newP1: [],
    deferred: [],
    ...over,
  });

  test("★ open 的条目被带过去 —— 它没被重列，但账本不能丢了它", () => {
    // 这就是那个洞：第 2 轮说「aaa 仍 open」但不重列 aaa，旧实现只写本轮 findings，
    // 于是第 3 轮的 `unadjudicated` 是空的 —— **静默「收敛」**。
    const next = nextRoundState(prior, conv({ open: ["aaa"] }), []);
    expect(next.map((f) => f.id)).toEqual(["aaa"]);
  });

  test("unadjudicated / regressed 同样带过去 —— 三者都是没了结", () => {
    expect(nextRoundState(prior, conv({ unadjudicated: ["aaa"] }), []).map((f) => f.id)).toEqual([
      "aaa",
    ]);
    expect(nextRoundState(prior, conv({ regressed: ["bbb"] }), []).map((f) => f.id)).toEqual([
      "bbb",
    ]);
  });

  test("★ REJECT：fixed 的不带 —— 否则账本只增不减，永远收敛不了", () => {
    // 缺这一臂，一个「把 prior 全带过去」的实现满足上面每一条断言。
    expect(nextRoundState(prior, conv({ converged: true }), [])).toEqual([]);
  });

  test("这一轮的新条目照常进，并且按 id 去重（新版本优先）", () => {
    const fresh: ReviewFinding[] = [
      { severity: "P1", title: "还没修", file: "a.ts", line: "99", body: "行号变了" },
    ];
    const next = nextRoundState(prior, conv({ open: ["aaa"] }), fresh);
    // 同一条 finding 换了行号 ⇒ id 变了，两条都在；关键是 aaa 没丢。
    expect(next.map((f) => f.id)).toContain("aaa");
    expect(next.length).toBe(2);
  });

  test("★ 第 1 轮（没有 convergence）行为不变 —— 只写本轮", () => {
    const fresh: ReviewFinding[] = [
      { severity: "P2", title: "t", file: "c.ts", line: "3", body: "b" },
    ];
    expect(nextRoundState(prior, undefined, fresh)).toEqual(toStateFindings(fresh));
  });

  test("★ 正控：这组输入真的能区分「带过去」与「丢掉」", () => {
    const kept = nextRoundState(prior, conv({ open: ["aaa"] }), []).length;
    const dropped = toStateFindings([]).length; // 旧实现在同样输入下的结果
    expect([kept, dropped]).toEqual([1, 0]);
  });
});

describe("★★ 轮次判决的两个边界（#5697 review P2 ×2）", () => {
  const conv = (over: Partial<Convergence>): Convergence => ({
    converged: false,
    unadjudicated: [],
    open: [],
    regressed: [],
    newP1: [],
    deferred: [],
    ...over,
  });
  const at = (round: number, c: Convergence, findings: ReviewFinding[] = []) =>
    reviewResultForRound({
      reviewerEngine: "codex",
      subjectEngine: "claude",
      findings,
      round,
      convergence: c,
    });

  test("★ 声明的上限在**它自己那一轮**就要叫人（曾经是 off-by-one）", () => {
    // `ROUND_CAP = 3` 声明的是「第 3 轮是上限」。旧条件 `round > ROUND_CAP` 在第 3 轮
    // 是假 —— 「到顶了」与「还没到顶」在边界那一轮同色，要到第 4 轮才 escalate。
    expect(at(ROUND_CAP - 1, conv({ open: ["x"] })).escalate).toBe(false);
    expect(at(ROUND_CAP, conv({ open: ["x"] })).escalate).toBe(true);
  });

  test("到顶那一轮的 result 仍是 BLOCKED —— escalate 是附加信号，不是替代", () => {
    expect(at(ROUND_CAP, conv({ open: ["x"] })).result).toBe("BLOCKED");
  });

  const p2: ReviewFinding = { severity: "P2", title: "新的小问题", file: "a.ts", body: "b" };
  const p1: ReviewFinding = { severity: "P1", title: "新的大问题", file: "a.ts", body: "b" };

  test("★ deferred 的非 P1 不打断收敛 —— 这条行为以前是死代码", () => {
    // 旧写法先算 reviewResult()，它只要有 finding 就 FAIL 并直接返回，于是
    // `Convergence.deferred` 那句注释描述的行为一次都没发生过。
    expect(at(2, conv({ converged: true, deferred: ["d1"] }), [p2]).result).toBe("PASS");
  });

  test("★ REJECT：新的 P1 仍然打断 —— 否则上面那条就是「什么都放行」", () => {
    // 缺这一臂，一个「第 2 轮起一律 PASS」的实现满足上面每一条断言。
    expect(at(2, conv({ newP1: ["n1"] }), [p1]).result).toBe("BLOCKED");
  });

  test("★ REJECT：上一轮没了结的仍然打断", () => {
    expect(at(2, conv({ open: ["o1"] }), []).result).toBe("BLOCKED");
    expect(at(2, conv({ unadjudicated: ["u1"] }), []).result).toBe("BLOCKED");
    expect(at(2, conv({ regressed: ["r1"] }), []).result).toBe("BLOCKED");
  });

  test("★ 第 1 轮行为不变：有 finding 就是 FAIL（没有上一轮可判定）", () => {
    expect(at(1, conv({}), [p2]).result).toBe("FAIL");
    expect(at(1, conv({}), []).result).toBe("PASS");
  });

  test("★ BLOCKED 的两个来源在任何轮次都压过收敛", () => {
    const blocked = (over: Record<string, unknown>) =>
      reviewResultForRound({
        reviewerEngine: "codex",
        subjectEngine: "claude",
        findings: [],
        round: 2,
        convergence: conv({ converged: true }),
        ...over,
      }).result;
    expect(blocked({ unparseable: true })).toBe("BLOCKED");
    expect(blocked({ subjectEngine: "codex" })).toBe("BLOCKED"); // 同引擎
  });

  test("★ 正控：这组输入真的能区分开三种判决", () => {
    const rs = [
      at(2, conv({ converged: true }), [p2]).result,
      at(2, conv({ newP1: ["n"] }), [p1]).result,
      at(1, conv({}), [p2]).result,
    ];
    expect(rs).toEqual(["PASS", "BLOCKED", "FAIL"]);
    expect(new Set(rs).size).toBe(3);
  });
});

describe("★★ 零 finding 只能由契约规定的哨兵证明（#5697 第 2 轮 review P1）", () => {
  const S = "Full review comments:";
  const parse = (body: string) => parseReviewReport(`总结。\n${S}\n${body}\n`);

  test("★ ACCEPT：`(none)` 及其无歧义变体 —— 缺这一臂，一个全拒的解析器满足下面每一条", () => {
    for (const body of ["(none)", "none", "(NONE).", "  (none)  "]) {
      const r = parse(body);
      expect(r.ok).toBe(true);
      expect(r.ok && r.findings.length).toBe(0);
    }
  });

  test("★ REJECT：一个裸 `-` 不是「审完了没问题」", () => {
    // 实测过的真实后果：reviewer 输出被截断、吐了个占位符、或者根本没答完，
    // 只要末尾落在一个连字符上，闸就放行合并。
    expect(parse("-").ok).toBe(false);
  });

  test("REJECT：破折号 / N/A / 空白同理 —— 它们都不是完成标记", () => {
    for (const body of ["—", "N/A", "n/a", "", "   "]) {
      expect(parse(body).ok).toBe(false);
    }
  });

  test("★ 正控：这组输入真的能区分开（否则上面三条可能只是碰巧同向）", () => {
    const verdicts = ["(none)", "-", "N/A"].map((b) => parse(b).ok);
    expect(verdicts).toEqual([true, false, false]);
    expect(new Set(verdicts).size).toBe(2);
  });

  test("★ 契约与实现不许分叉：REPORT_CONTRACT 里写的就是 `(none)`", () => {
    // 这条分叉正是本 bug 的来源 —— 契约说「只写一行 (none)」，而哨兵认 5 种形状。
    expect(REPORT_CONTRACT).toContain("(none)");
  });
});

describe("★ fallbackBins 必须真的被用上（#5697 第 2 轮 review P2）", () => {
  const e = {
    bin: "claude",
    fallbackBins: ["claude-code"],
    args: () => [],
    outputMode: "stdout" as const,
  };
  const only = (name: string) => (c: string) => (c === name ? `/usr/bin/${c}` : null);

  test("主 bin 在 → 用它", () => {
    expect(resolveReviewerBin(e, only("claude"))).toBe("claude");
  });

  test("★ 只装了别名 → 用别名（这是修之前 ENOENT + 永久 BLOCKED 的那一支）", () => {
    // 修之前命令构造是 `[e.bin, ...]`，fallbackBins 一次都没被消费：
    // 只装了 `claude-code` 的部署在普通 engine probe 里「可用」，
    // 到了 local-review 却 ENOENT —— 「没装」与「装的是别名」同色。
    expect(resolveReviewerBin(e, only("claude-code"))).toBe("claude-code");
  });

  test("★ REJECT：一个都没有 → 回落主名，让 spawn 以 ENOENT 报出那个名字", () => {
    // 不在这里抛「没有可用引擎」：错误信息里带着它试过的名字更容易查。
    expect(resolveReviewerBin(e, () => null)).toBe("claude");
  });

  test("没有 fallbackBins 时行为不变", () => {
    expect(resolveReviewerBin({ ...e, fallbackBins: undefined }, only("claude-code"))).toBe(
      "claude",
    );
  });

  test("★ 正控：这组输入真的能区分「用了 fallback」与「只用 bin」", () => {
    // 一个 `return e.bin` 的实现在第 2 条上必须给出不同答案。
    expect([
      resolveReviewerBin(e, only("claude")),
      resolveReviewerBin(e, only("claude-code")),
    ]).toEqual(["claude", "claude-code"]);
  });
});

describe("★★ reviewerArgv 必须真的走 resolveReviewerBin（#5697 第 2 轮 review P2）", () => {
  /**
   * 上一条 describe 只测了 `resolveReviewerBin` 这个**纯函数**。实测变异证明那不够：
   * 把 `reviewerArgv` 改回 `[e.bin, ...]`，上面 5 条**全绿** ——
   * **「解析器是对的」与「命令构造用了解析器」是两件事**，在那组测试上同色。
   */
  test("★ 只装了别名时，argv[0] 必须是别名（把接线也钉住）", () => {
    setReviewerEngines({
      probe: {
        bin: "probe-primary",
        fallbackBins: ["probe-alias"],
        args: () => ["review"],
        outputMode: "stdout",
      },
    });
    const only = (name: string) => (c: string) => (c === name ? `/usr/bin/${c}` : null);
    expect(
      reviewerArgv("probe", { prompt: "p", base: "origin/main" }, only("probe-alias"))[0],
    ).toBe("probe-alias");
    // ★ 正控：主 bin 在时仍然用主 bin —— 否则上面那条可能只是「永远用最后一个」
    expect(
      reviewerArgv("probe", { prompt: "p", base: "origin/main" }, only("probe-primary"))[0],
    ).toBe("probe-primary");
  });
});

describe("★★ base 必须被刷新并固定成不可变 SHA（#5697 review P1）", () => {
  /**
   * 这条守的是 `scripts/local-review.ts` 里那段：`git fetch` → `git rev-parse` →
   * 用 SHA 而不是 `origin/<branch>`。逻辑住在脚本里（它要跑 git），所以这里钉的是
   * **契约**：交给 reviewer 的 base 必须是 40 位 SHA。
   *
   * 为什么这条重要：可变 ref 让「审过了」与「审的是过期范围」同色 —— 而后者给出的是
   * 一个看起来完全正常的 PASS。实测（人为把本地 `origin/main` 退回 40 个提交）：
   *
   *     修前  base = origin/main  → 拿着 ca559ce2 那个陈旧 ref 去审
   *     修后  fetch 拉平后固定    → 05d0ebf1，即远端真实 tip
   */
  const SHA40 = /^[0-9a-f]{40}$/;

  test("★ ACCEPT：40 位 SHA 是合法的 base", () => {
    expect(SHA40.test("05d0ebf10b4249a1b2c3d4e5f60718293a4b5c6d")).toBe(true);
  });

  test("★ REJECT：可变分支引用不是 —— 这就是修掉的那个形状", () => {
    for (const bad of ["origin/main", "main", "HEAD", "origin/master", ""]) {
      expect(SHA40.test(bad)).toBe(false);
    }
  });

  test("REJECT：短 SHA 也不够 —— 它仍然要靠仓库状态才能解析", () => {
    expect(SHA40.test("05d0ebf")).toBe(false);
  });

  test("★ 正控：这组输入真的能区分（否则上面两条可能同向）", () => {
    const verdicts = ["05d0ebf10b4249a1b2c3d4e5f60718293a4b5c6d", "origin/main"].map((b) =>
      SHA40.test(b),
    );
    expect(verdicts).toEqual([true, false]);
  });
});

describe("★★ 只有契约声明的 P2/P3 才可推迟（#5697 第 4 轮 review P1）", () => {
  const prior = [{ id: "a", severity: "P1", title: "t", file: "f.ts", line: "1" }];
  const fixed = new Map<string, Disposition>([["a", "fixed"]]);
  const verdict = (severity: string) => {
    const nf = [{ severity, title: "新问题", file: "x.ts", body: "b" }];
    const c = convergence(prior, fixed, nf);
    return reviewResultForRound({
      reviewerEngine: "codex",
      subjectEngine: "claude",
      findings: nf,
      round: 2,
      convergence: c,
    }).result;
  };

  test("★ REJECT：P0 比 P1 更重，绝不能因为「不等于 P1」就被推迟", () => {
    // 修之前 `deferred = severity !== "P1"`，于是 P0 落进 deferred → 第 2 轮起 PASS。
    // **「不是 P1」被读成了「不严重」** —— 而那正是放行合并的那个答案。
    expect(verdict("P0")).toBe("BLOCKED");
  });

  test("★ REJECT：不认识的严重度是证据不可解，不是「轻微」", () => {
    for (const s of ["P9", "PX", "critical", ""]) expect(verdict(s)).toBe("BLOCKED");
  });

  test("P1 照常打断", () => {
    expect(verdict("P1")).toBe("BLOCKED");
  });

  test("★ ACCEPT：P2 / P3 才是契约允许推迟的 —— 缺这一臂，一个「全挡」的实现全绿", () => {
    expect(verdict("P2")).toBe("PASS");
    expect(verdict("P3")).toBe("PASS");
  });

  test("★ 正控：这组输入真的能区分（否则上面几条可能只是同向）", () => {
    const vs = ["P0", "P2", "P9"].map(verdict);
    expect(vs).toEqual(["BLOCKED", "PASS", "BLOCKED"]);
    expect(new Set(vs).size).toBe(2);
  });
});

const SHA40 = "3fa00a72841e15a377c36cb5e3c8a092a6d3fd93";

describe("★ pickDefaultReviewer —— 省略 --engine 也不得同引擎（#5697 f1gtawqv）", () => {
  test("★ coder=codex 时默认 reviewer 不是 codex", () => {
    const picked = pickDefaultReviewer("codex");
    expect(picked).toBeDefined();
    expect(picked).not.toBe("codex");
    expect(crossEngineVerdict(picked, "codex").ok).toBe(true);
  });

  test("ACCEPT：coder=claude 可以落到已注册的另一个引擎（含 codex）", () => {
    const picked = pickDefaultReviewer("claude");
    expect(picked).toBeDefined();
    expect(picked).not.toBe("claude");
    expect(crossEngineVerdict(picked, "claude").ok).toBe(true);
  });

  test("★ coder 未注册 → 不猜，返回 undefined（否则会挑一个「看起来跨引擎」的假名）", () => {
    expect(pickDefaultReviewer("codxe")).toBeUndefined();
    expect(pickDefaultReviewer(undefined)).toBeUndefined();
  });

  test("★ 重跑命令带上 --engine <picked>，不再省略", () => {
    const hint = localReviewRerunHint("5697", "codex");
    expect(hint).toContain("--pr 5697");
    expect(hint).toMatch(/--engine\s+(alpha|beta|claude|grok)\b/);
    expect(hint).not.toMatch(/--engine\s+codex(?:\s|$)/);
    expect(hint).not.toContain("<other");
    expect(hint).toContain("--post");
  });
});

describe("★ attestLocalReview —— 独立性按 heading 重算，不按 GitHub 账号（#5697 f1pxdxbw / B）", () => {
  const clean = renderReviewComment({
    reviewerEngine: "codex",
    subjectEngine: "claude",
    sha: SHA40,
    base: "origin/main",
    findings: [],
  });

  test("★ ACCEPT：同一 GitHub 账号、跨引擎 PASS —— 工厂同 token 默认形态", () => {
    const r = attestLocalReview({
      body: clean,
      author: "coder",
      prAuthor: "coder",
      coderEngine: "claude",
      prHead: SHA40,
    });
    expect(r.ok).toBe(true);
  });

  test("ACCEPT：不同 GitHub 身份仍然放行（login 只是审计字段）", () => {
    const r = attestLocalReview({
      body: clean,
      author: "reviewer-bot",
      prAuthor: "coder",
      coderEngine: "claude",
      prHead: SHA40,
    });
    expect(r.ok).toBe(true);
  });

  test("★ ACCEPT：缺 GitHub author 不阻断 —— login 不是独立性证明", () => {
    const r = attestLocalReview({
      body: clean,
      author: undefined,
      prAuthor: "coder",
      coderEngine: "claude",
      prHead: SHA40,
    });
    expect(r.ok).toBe(true);
  });

  test("★ REJECT：NA 这道门不收（docs/native 豁免不是跨引擎证据）", () => {
    const na = clean.replace("result=PASS", "result=NA");
    const r = attestLocalReview({
      body: na,
      author: "coder",
      prAuthor: "coder",
      coderEngine: "claude",
      prHead: SHA40,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/NA|PASS/i);
  });

  test("★ REJECT：一行伪造 marker 没有 heading 引擎 → 挡", () => {
    const r = attestLocalReview({
      body: `<!-- local-review sha=${SHA40} result=PASS -->`,
      author: "coder",
      prAuthor: "coder",
      coderEngine: "claude",
      prHead: SHA40,
    });
    expect(r.ok).toBe(false);
  });

  test("★ REJECT：marker 写 PASS、heading 是同引擎 → 独立性重算为 BLOCKED", () => {
    const forged = renderReviewComment({
      reviewerEngine: "claude",
      subjectEngine: "claude",
      sha: SHA40,
      base: "origin/main",
      findings: [],
    }).replace("result=BLOCKED", "result=PASS");
    const r = attestLocalReview({
      body: forged,
      author: "coder",
      prAuthor: "coder",
      coderEngine: "claude",
      prHead: SHA40,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/same-engine|independence|BLOCKED/i);
  });

  test("parseReviewerEngineFromComment 从 heading 取出 reviewer", () => {
    expect(parseReviewerEngineFromComment(clean)).toBe("codex");
    expect(parseReviewerEngineFromComment("no heading")).toBeUndefined();
  });
});

describe("★ requireLocalReviewSticky —— 闸接线（独立性按 heading，login 只审计）", () => {
  const clean = renderReviewComment({
    reviewerEngine: "codex",
    subjectEngine: "claude",
    sha: SHA40,
    base: "origin/main",
    findings: [],
  });
  const runnerOf = (comment: unknown) => () => ({
    code: 0,
    out: JSON.stringify(comment),
    ms: 0,
  });

  test("★ ACCEPT：同一 GitHub 身份的跨引擎 PASS（同 token 工厂路径）", () => {
    const r = requireLocalReviewSticky(
      "5697",
      SHA40,
      "hint",
      runnerOf({ body: clean, user: { login: "coder" } }),
      { prAuthor: "coder", coderEngine: "claude" },
    );
    expect(r.ok).toBe(true);
  });

  test("ACCEPT：不同 GitHub 身份同样放行", () => {
    const r = requireLocalReviewSticky(
      "5697",
      SHA40,
      "hint",
      runnerOf({ body: clean, user: { login: "reviewer-bot" } }),
      { prAuthor: "coder", coderEngine: "claude" },
    );
    expect(r.ok).toBe(true);
  });

  test("★ REJECT：result=NA 即使跨引擎", () => {
    const na = clean.replace("result=PASS", "result=NA");
    const r = requireLocalReviewSticky(
      "5697",
      SHA40,
      "hint",
      runnerOf({ body: na, user: { login: "coder" } }),
      { prAuthor: "coder", coderEngine: "claude" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/PASS/i);
  });
});
