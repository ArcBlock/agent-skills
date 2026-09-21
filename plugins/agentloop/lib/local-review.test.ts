import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireStickyGate } from "./gate";
import {
  agentAuthored,
  appendCoderEngine,
  assertCwdIsPrHead,
  assertReviewerEngine,
  attestLocalReview,
  type Convergence,
  coderEngineClaim,
  collectReviewOutput,
  contractRetryPrompt,
  convergence,
  crossEngineVerdict,
  type Disposition,
  dispositionParseDiag,
  formatDispositionParseDiag,
  formatReviewRawArtifact,
  fulfillReviewContract,
  LOCAL_REVIEW_PREFIX,
  localReviewRerunHint,
  nextRound,
  nextRoundState,
  parseCodexReview,
  parsePriorDispositions,
  parseReviewerEngineFromComment,
  parseReviewReport,
  parseReviewState,
  persistReviewRaw,
  pickDefaultReviewer,
  REPORT_CONTRACT,
  REVIEW_OUTPUT_SCHEMA,
  type ReviewFinding,
  ROUND_CAP,
  renderReviewComment,
  requireLocalReviewSticky,
  rerunDiscipline,
  resolveReviewerBin,
  resolveSubjectEngine,
  reviewExcerpt,
  reviewerArgv,
  reviewerEngines,
  reviewResult,
  reviewResultForRound,
  roundPrompt,
  type StateFinding,
  setReviewerEngines,
  toStateFindings,
  unionCoderEngines,
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
  "grok-build": {
    bin: "grok",
    fallbackBins: ["grok-build"],
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

  /**
   * arc#6153 —— 真实产物,不是照着格式编的。
   *
   * `grok-build` 审 PR #6002 时输出了一条**完全符合契约**的 finding,只是把
   * `path:line` 包进了反引号——markdown 里最自然的写法,而这份契约本身就印在
   * markdown 上下文里。`FINDING_RE` 结尾是 `(\d+(?:-\d+)?)\s*$`,行尾多出的那个
   * 反引号让整条匹配不上;小节里没有别的可认的东西,`unclaimed` 也归零,于是判
   * unparseable。
   *
   * 后果不是「少认一条」,是**「reviewer 报了问题」被渲染成「reviewer 输出读不懂」**——
   * 两者在 `result=BLOCKED` 上同色,而我按那个 marker 读成了前者。那条 P3 说得对
   * (同一文件里 restart 用例仍有本 PR 刚修掉的时序问题),差点随工具缺陷一起消失。
   */
  test("★ arc#6153: 反引号包裹的 path:line 仍是一条 finding,不是「读不懂」", () => {
    const real = [
      "先把这次 diff 和被改文件的上下文看清楚。这次改动的生产逻辑是对的。",
      "",
      "Full review comments:",
      "",
      "- [P3] restart e2e 仍在端口断言之后才登记新 pid — `runtimes/node/test/daemon/dual-instance-catalog.e2e.test.ts:415-418`",
      "  restart 一旦杀了旧进程、又在别的端口拉起新进程,端口断言会扔,新 pid 从未登记。",
    ].join("\n");
    const r = parseCodexReview(real);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings.length).toBe(1);
    const found = r.findings[0];
    expect(found).toBeDefined();
    if (!found) return;
    expect(found).toMatchObject({
      severity: "P3",
      // 反引号必须被剥掉——留着它,贴到 PR 上的链接点不开。
      file: "runtimes/node/test/daemon/dual-instance-catalog.e2e.test.ts",
      line: "415-418",
    });
    expect(found.title).not.toContain("`");
  });

  /**
   * arc#6199 的 reject 臂 —— 放宽位置的包裹时,**不能顺手放宽「什么算一条 finding」**。
   *
   * 这一条是变异测试逼出来的,不是设想:把 `^-\s*\[(P\d)\]` 弱化成
   * `^-?\s*\[?(P\d)?\]?` 之后,141 条测试**全绿**——没有任何东西钉着「必须是
   * `- [Pn]` 开头」。一个这样被弱化的正则会把正文里随口提到 `path:line` 的散文行
   * 提升成一条 severity 为 undefined 的 finding,而那正是 accept-path 铁律的反面:
   * 一个「什么都算一条」的解析器满足每一条「它认出了 finding」的断言。
   */
  test("★ arc#6199 reject: 正文里提到 path:line 的散文行不是 finding,要归进上一条的正文", () => {
    const report = [
      "看过 diff 了。",
      "",
      "Full review comments:",
      "",
      "- [P2] 真的 finding — packages/core/src/a.ts:10",
      "  上面那条的正文。",
      // 这一行**必须带 ` — `**,否则它对 `- [Pn]` 锚点没有判别力:正则要求标题与位置
      // 之间有破折号,不带破折号的散文行在弱化前后都匹配不上,测试会假绿。第一版就是
      // 这么写的,变异 M3 照样全绿,是变异测试把它照出来的。
      "顺带一提 — packages/core/src/b.ts:20 那一段没问题。",
    ].join("\n");
    const r = parseCodexReview(report);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 判别项:弱化 `- [Pn]` 锚点后这里会变成 2。
    expect(r.findings.length).toBe(1);
    expect(r.findings[0]).toMatchObject({ severity: "P2", file: "packages/core/src/a.ts" });
    // 那行散文不许消失——它折进正文,不被静默丢弃。
    expect(r.findings[0]?.body ?? "").toContain("packages/core/src/b.ts:20");
    // 且不许出现 severity 缺失的「finding」。
    for (const f of r.findings) expect(f.severity).toMatch(/^P\d$/);
  });

  /**
   * arc#6199 —— 第三个真实变体,也是 #6153 那次修得**不够宽**的证据。
   *
   * #6153 修的是 `` `path:line` ``(反引号包住整个 位置)。实盘出现的第三种写法是
   * `` `path`:line `` —— **反引号在冒号之前就闭合了**,只包路径、行号留在外面。这同样
   * 是 markdown 里最自然的写法之一(路径是代码,行号不是),而 `([^\s`]+?)` 这个字符类
   * **跨不过反引号**,于是 `` ` `` 之后紧跟的不是 `:`,整条匹配失败。
   *
   * 实盘(PR #6112,grok-build 审,1019s):raw 产物 2419 bytes、nonce 独占最后一行、
   * 中间是两条格式完好的 P2,而 sticky 上渲染出来的是 **`0 条 · 判决 BLOCKED`**。两条都
   * 经人工对代码核实为真。
   *
   * fail-closed 那一半是对的(#6123 的不变量:认不出绝不渲染成「干净」)。坏的是另一侧:
   * findings 只剩在 raw 文件里,而**「BLOCKED 了就再跑一次」是一次有损重试**——下一轮若
   * 恰好写成可解析的形状,2 条就变成了 0 条,且没有任何东西会说少了什么。
   */
  test("★ arc#6199: `path`:line(反引号在冒号前闭合)仍是 finding,不是「读不懂」", () => {
    const real = [
      "先看 diff,再读被改文件的上下文。",
      "",
      "Full review comments:",
      "",
      "- [P2] Kotlin `isInternalArtifact` 只看词汇路径,list 会把指向锁目录的 symlink 当普通内容 — `platforms/kotlin/afs-files/src/main/kotlin/io/aigne/afs/files/FilesProvider.kt`:201-225",
      "- [P2] Kotlin 的 sidecar delete/rename 测试仍断言某一种合法串行结果 — `platforms/kotlin/afs-files/src/test/kotlin/io/aigne/afs/files/FilesProviderTests.kt`:788-794",
    ].join("\n");
    const r = parseCodexReview(real);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 判别项:修之前这里是 0(整份 unparseable),不是 1。
    expect(r.findings.length).toBe(2);
    expect(r.findings[0]).toMatchObject({
      severity: "P2",
      file: "platforms/kotlin/afs-files/src/main/kotlin/io/aigne/afs/files/FilesProvider.kt",
      line: "201-225",
    });
    expect(r.findings[1]).toMatchObject({
      severity: "P2",
      file: "platforms/kotlin/afs-files/src/test/kotlin/io/aigne/afs/files/FilesProviderTests.kt",
      line: "788-794",
    });
    // 只有 **file** 必须去掉反引号——留着它,贴到 PR 上的链接点不开。
    // title 里的反引号要**保留**:`isInternalArtifact` 是正文里的行内代码,不是位置的
    // 包裹。这条断言最初照抄了 #6153 那条(那次的 title 恰好不含反引号),于是把
    // 「剥掉位置的包裹」写成了「剥掉一切反引号」——会毁掉 finding 正文的可读性。
    for (const f of r.findings) {
      expect(f.file).not.toContain("`");
    }
    expect(r.findings[0]?.title).toContain("`isInternalArtifact`");
  });

  /**
   * 同一天的**第二个**真实变体(arc#6153):epic #6042 的 conductor 在 PR #6140 上
   * 第 12 轮 review 里,reviewer 在 `path:line` 之后加了一个圆括号注记,同样被整条
   * 吞成 unparseable —— 那一轮报的是一条 P1(bun 的 unowned stdout wait 没有超时,
   * 会挂死),而它差点因为一个括号消失。
   *
   * 所以容忍的不是「反引号」这一个字符,是**位置之后的注记**。注记不丢:折进正文,
   * 因为这个文件自己的规矩是「超出要**说出来**,不能悄悄截」。
   */
  test("★ arc#6153: path:line 之后的注记不改变「这是一条 finding」,且注记不被丢弃", () => {
    const withNote = [
      "S",
      "",
      "Full review comments:",
      "",
      "- [P1] bun 的 unowned stdout wait 没有超时 — runtimes/node/src/cli-bin.ts:88 (round 12)",
      "  handler dump 打进停住的 reader 会永远到不了 process.exit。",
    ].join("\n");
    const r = parseCodexReview(withNote);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings.length).toBe(1);
    const f = r.findings[0];
    expect(f).toBeDefined();
    if (!f) return;
    expect(f.severity).toBe("P1");
    expect(f.file).toBe("runtimes/node/src/cli-bin.ts");
    expect(f.line).toBe("88");
    // 注记不许悄悄消失。
    expect(f.body).toContain("round 12");
    expect(f.body).toContain("永远到不了");
  });

  test("★ arc#6153: 标题里含破折号时,位置取最后一个 — 之后的那段", () => {
    const emdashInTitle = [
      "S",
      "",
      "Full review comments:",
      "",
      "- [P2] A — B 两条路径不一致 — packages/core/src/afs.ts:12",
    ].join("\n");
    const r = parseCodexReview(emdashInTitle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const f = r.findings[0];
    expect(f).toBeDefined();
    if (!f) return;
    expect(f.file).toBe("packages/core/src/afs.ts");
    expect(f.line).toBe("12");
    expect(f.title).toBe("A — B 两条路径不一致");
  });

  /**
   * arc#6123 —— **review 闸的 accept path 从来没有成立过。**
   *
   * codex 在没发现问题时**整节不写**,只回一段散文结论;而 `(none)` 哨兵是解析器
   * 认「干净」的唯一形状。于是:有 finding → 可解析 → `FAIL`;没有 finding →
   * unparseable → `BLOCKED`。**一道只会说 FAIL/BLOCKED、永远说不出 PASS 的闸,
   * 与一道全拒的闸完全同色** —— 这正是本仓 accept-path 铁律说的那件事,只是这次
   * 落在 review 工具自己身上。
   *
   * 修法不是「相信空白」(空白与被截断无法区分,那是原设计刻意拒绝的),而是让引擎
   * 原样复制一个**一次性 nonce**:nonce 在 = 这份输出完整。于是
   * 「完整且零条」与「被截断」不再同色,而不必依赖引擎记得写 `(none)`。
   *
   * 加法,不改既有语义:不传 nonce 时行为逐字节不变。
   */
  /**
   * ★ 设计更正(codex 第 3 轮的 P1,它是对的):**「输出完整 + 没有可识别的 finding」
   * 不能等于「干净」**——"我没审成"同样是完整且零 finding。实测两种都会被放行:
   * 编号列表 `1. [P1] …`(不匹配 `- [Pn]` 扫描)、以及「无法读取仓库,未完成审查」。
   *
   * 所以 #6123 的前提(不靠哨兵也能认干净)不成立。nonce 能证明**输出结束**,
   * 永远证明不了**没有问题**。两个方向都要正面证据:
   *   干净 ⟸ 显式 `(none)` 哨兵;完整 ⟸ nonce。缺任一 ⟹ unparseable。
   */
  test("★ arc#6123 REJECT: 完整但没有正面的「干净」证据,一律 unparseable", () => {
    const NONCE = "arc-review-nonce-0f1e2d3c";
    // 散文结论 + nonce:输出完整,但没说「没问题」——不许当干净。
    expect(
      parseCodexReview(["已审查全部改动,未发现缺陷。", "", NONCE].join("\n"), { nonce: NONCE }).ok,
    ).toBe(false);
    // 更要命的一种:根本没审成,也会是「完整 + 零 finding」。
    expect(
      parseCodexReview(["无法读取仓库,未完成审查。", "", NONCE].join("\n"), { nonce: NONCE }).ok,
    ).toBe(false);
    // 编号列表的 finding:认不出就拒绝,不许静默成零条。
    expect(
      parseCodexReview(["有问题。", "", "1. [P1] 错误放行 — a.ts:7", "", NONCE].join("\n"), {
        nonce: NONCE,
      }).ok,
    ).toBe(false);
  });

  test("★ arc#6123: 哨兵不得为「认不出的问题行」背书", () => {
    const NONCE = "arc-review-nonce-0f1e2d3c";
    // codex 第 4 轮指出的残余洞:同时存在 `(none)` 和一条认不出的问题行时,
    // 只扫 `- [Pn]` 的 orphan 检测扫不到编号列表,于是走哨兵分支判干净 ——
    // **哨兵替一条它没看见的 finding 背了书。**
    const sentinelPlusUnrecognised = [
      "审查结论如下。",
      "",
      "(none)",
      "",
      "1. [P1] 错误放行 — a.ts:7",
      "",
      NONCE,
    ].join("\n");
    expect(parseCodexReview(sentinelPlusUnrecognised, { nonce: NONCE }).ok).toBe(false);
    // 同理:带小节头时,认不出的问题行也不许被哨兵盖过去。
    const inSection = [
      "S",
      "",
      "Full review comments:",
      "",
      "(none)",
      "1. [P2] 也是个问题 — b.ts:9",
      "",
      NONCE,
    ].join("\n");
    expect(parseCodexReview(inSection, { nonce: NONCE }).ok).toBe(false);
  });

  test("★ arc#6123 ACCEPT: 显式 (none) + nonce = 干净(哨兵可以不带小节头)", () => {
    const NONCE = "arc-review-nonce-0f1e2d3c";
    const withSentinel = ["审完了,没问题。", "", "(none)", "", NONCE].join("\n");
    const r = parseCodexReview(withSentinel, { nonce: NONCE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings.length).toBe(0);
  });

  test("★ arc#6123 P2: nonce 必须是最后一个非空行,正文里提到它不算结束证明", () => {
    const NONCE = "arc-review-nonce-0f1e2d3c";
    // 实测逃逸:只说「本轮的结束标记是 <nonce>,开始审查。」就被 `includes` 判为完整。
    const mentioned = `本轮的结束标记是 ${NONCE},开始审查。`;
    expect(parseCodexReview(mentioned, { nonce: NONCE }).ok).toBe(false);

    // ★ 上面那条**分辨不出** `includes` 与「独占末行」——两种实现下它都因为缺哨兵
    //   而 unparseable。一条看不见自己要保护的东西的正控等于没有(自己做变异时实测:
    //   把判据换回 `includes`,整套仍 139 pass)。下面这条才是那个判别量:
    //   正文里提到 nonce **且**写了哨兵,但输出在之后被截断 —— `includes` 会判干净。
    const mentionedThenTruncated = [
      `本轮的结束标记是 ${NONCE},现在开始审查。`,
      "",
      "(none)",
      "",
      "接下来我还要检查第二个文件……",
    ].join("\n");
    expect(parseCodexReview(mentionedThenTruncated, { nonce: NONCE }).ok).toBe(false);
  });

  test("★ arc#6123 P2: 无小节头救回的 finding 必须带上正文", () => {
    const NONCE = "arc-review-nonce-0f1e2d3c";
    const noHeaderWithBody = [
      "有问题。",
      "",
      "- [P1] 错误放行 — packages/core/src/afs.ts:7",
      "  只有在 X 且 Y 时才会触发,修法是 Z。",
      "",
      NONCE,
    ].join("\n");
    const r = parseCodexReview(noHeaderWithBody, { nonce: NONCE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings.length).toBe(1);
    // 正文被静默丢掉的话,交付到 PR 上只剩标题,触发条件和修法都没了。
    expect(r.findings[0]?.body).toContain("修法是 Z");
  });

  test("★ arc#6123 ACCEPT: nonce 在 + 有小节有 finding,照常解析", () => {
    const NONCE = "arc-review-nonce-0f1e2d3c";
    const withFinding = [
      "有一个问题。",
      "",
      "Full review comments:",
      "",
      "- [P2] 某处会错 — packages/core/src/afs.ts:7",
      "  说明。",
      "",
      NONCE,
    ].join("\n");
    const r = parseCodexReview(withFinding, { nonce: NONCE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings.length).toBe(1);
    expect(r.findings[0]?.file).toBe("packages/core/src/afs.ts");
  });

  test("★ arc#6123 REJECT: nonce 不在 = 截断/没跑完,一律 unparseable", () => {
    const NONCE = "arc-review-nonce-0f1e2d3c";
    // 这条是上面两条的正控。少了它,一个「有 nonce 参数就当干净」的实现会让 accept
    // 臂全绿,而把**被截断的输出**也读成「审完了、干净」—— 干净是那个会放行合并的答案。
    expect(parseCodexReview("已审查……未发现问题。", { nonce: NONCE }).ok).toBe(false);
    // 小节头之后被截断,nonce 也没打出来 —— 仍然是没跑完。
    expect(parseCodexReview("S\n\nFull review comments:\n", { nonce: NONCE }).ok).toBe(false);
    // nonce 参数存在但输出里带的是**别的** nonce(上一轮的复述)也不算。
    expect(parseCodexReview(`审完了。\n\narc-review-nonce-DIFFERENT`, { nonce: NONCE }).ok).toBe(
      false,
    );
  });

  /**
   * codex 审这次修复时报的两条 P1(#6123 round 4),都对,都在这里钉住。
   *
   * (a) **严格照契约输出的干净报告反而被 BLOCKED**:`(none)` 之后的 nonce 行会进入
   *     小节解析循环、被计成 `unclaimed`。而脚本每轮都传 nonce ⟹ 新契约一落地,
   *     所有合法的零问题报告全被判 BLOCKED —— 我把要修的洞换个位置又挖了一遍。
   *
   * (b) **明确报出的 P1 被转成 PASS**:漏写小节标题但写了 finding 行 + 正确 nonce 时,
   *     「完整 ⟹ 零条」那条分支直接返回空 findings。**nonce 只能证明输出结束,
   *     不能证明没有问题** —— 这是 accept-path 铁律在反方向上的违规,比原 bug 更糟。
   */
  test("★ arc#6123 (a): 契约输出 = 小节 + (none) + 末尾 nonce,必须判干净", () => {
    const NONCE = "arc-review-nonce-aabbccdd";
    const strict = ["审完了,没问题。", "", "Full review comments:", "", "(none)", "", NONCE].join(
      "\n",
    );
    const r = parseCodexReview(strict, { nonce: NONCE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings.length).toBe(0);
  });

  test("★ arc#6123 (b): 漏写小节标题但报了 finding + nonce,不许当成零条", () => {
    const NONCE = "arc-review-nonce-aabbccdd";
    const noHeader = [
      "有问题。",
      "",
      "- [P1] 错误放行 — packages/core/src/afs.ts:7",
      "  说明。",
      "",
      NONCE,
    ].join("\n");
    const r = parseCodexReview(noHeader, { nonce: NONCE });
    // 要么把它解析成 1 条,要么拒绝;**唯独不能是「ok + 0 条」**——那会放行合并。
    if (r.ok) {
      expect(r.findings.length).toBe(1);
      expect(r.findings[0]?.file).toBe("packages/core/src/afs.ts");
    }
  });

  test("★ arc#6123 (b) 的正控:带显式哨兵的真·零条仍判干净", () => {
    const NONCE = "arc-review-nonce-aabbccdd";
    const prose = ["已审查全部改动,未发现缺陷。", "", "(none)", "", NONCE].join("\n");
    const r = parseCodexReview(prose, { nonce: NONCE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings.length).toBe(0);
  });

  test("★ arc#6123: 不传 nonce 时,既有语义逐字节不变", () => {
    // 向后兼容的正控:这条挂了说明修复改动了既有调用方的行为。
    expect(parseCodexReview("已审查……未发现问题。").ok).toBe(false);
    const clean = parseCodexReview("Looks good.\n\nFull review comments:\n\n(none)");
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.findings.length).toBe(0);
  });

  test("★ arc#6153 的 reject 臂:放宽不得放到「什么都算一条」", () => {
    // 这条是上一条的正控。一个「只要 `- [Pn]` 开头就算一条」的宽松正则会让上面
    // 那条绿,而把真正认不出的形状也吞成 0 条 finding + ok —— 那正是本文件开头
    // 那条「零条与没看懂必须不同色」要防的东西,只是换到了行级。
    const noLocation = [
      "S",
      "",
      "Full review comments:",
      "",
      "- [P2] 说了个问题但没给 path:line",
    ].join("\n");
    expect(parseCodexReview(noLocation).ok).toBe(false);
    const notAFinding = ["S", "", "Full review comments:", "", "- 随便一句话"].join("\n");
    expect(parseCodexReview(notAFinding).ok).toBe(false);
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

  test("★ 判定 id 锚定字符集，不吞 CJK / 冒号（#6064）", () => {
    // `(\S+)` 吃到第一个 ASCII 空白为止。CJK 没有 ASCII 空格；英文 `id: reason`
    // 的冒号粘在 id 上。两种自然写法都会把整段吞成 id，然后 scored 为漏判。
    const wrap = (line: string) =>
      ["总结", "", "Prior findings:", line, "", "Full review comments:", "", "(none)"].join("\n");
    const rows: ReadonlyArray<[string, string, Disposition]> = [
      ["- [fixed] f57ehu1：理由如此如此，已修", "f57ehu1", "fixed"],
      ["- [fixed] f57ehu1: reason here", "f57ehu1", "fixed"],
      ["- [open] abc1234，还没修", "abc1234", "open"],
      ["- [fixed] f57ehu1 ：理由", "f57ehu1", "fixed"],
      ["- [fixed] a1 修好了", "a1", "fixed"],
      ["- [fixed] `f57ehu1` 已修", "f57ehu1", "fixed"],
      ["- [fixed] **f57ehu1** 已修", "f57ehu1", "fixed"],
      ["* [fixed] f57ehu1 已修", "f57ehu1", "fixed"],
      // wrapping `_id_` — charset must not include `_` or the capture eats the closer.
      ["- [fixed] _f57ehu1_ 已修", "f57ehu1", "fixed"],
    ];
    for (const [line, id, status] of rows) {
      const d = parsePriorDispositions(wrap(line));
      expect([...d.keys()]).toEqual([id]);
      expect(d.get(id)).toBe(status);
    }
    // compact-findings 形状（fvo0yfm / f1ituu17 / a1）不得被字符集闸掉。
    const compact = parsePriorDispositions(
      wrap("- [fixed] fvo0yfm ok\n- [open] f1ituu17 still\n- [regressed] a1 back"),
    );
    expect([...compact.keys()]).toEqual(["fvo0yfm", "f1ituu17", "a1"]);
  });

  test("★ 漏判诊断：解析出的 id 与期望 id 必须同时可见（#6064）", () => {
    // 「reviewer 没写」与「写了但解析没对上」在只报「漏判 N」时同色。
    const swallowed = new Map<string, Disposition>([["f57ehu1：理由如此如此，已修", "fixed"]]);
    const parseFail = dispositionParseDiag(["f57ehu1"], swallowed);
    expect(parseFail).toEqual({
      expected: ["f57ehu1"],
      parsed: ["f57ehu1：理由如此如此，已修"],
      unmatched: ["f57ehu1"],
    });
    const parseFailMsg = formatDispositionParseDiag(parseFail);
    expect(parseFailMsg).toContain("f57ehu1");
    expect(parseFailMsg).toContain("f57ehu1：理由如此如此，已修");
    expect(parseFailMsg).toMatch(/解析出的判定 id/);
    // 5 leading spaces = GitHub code fence. Formatter must not indent; stderr adds its own.
    for (const line of parseFailMsg.split("\n")) {
      expect(line.startsWith("     ")).toBe(false);
    }

    const silent = dispositionParseDiag(["f57ehu1"], new Map());
    expect(silent).toEqual({
      expected: ["f57ehu1"],
      parsed: [],
      unmatched: ["f57ehu1"],
    });
    const silentMsg = formatDispositionParseDiag(silent);
    expect(silentMsg).toContain("f57ehu1");
    expect(silentMsg).toMatch(/\(none\)/);
    // 两种颜色不得逐字相同 —— 否则打印机可以静静丢掉 parsed。
    expect(silentMsg).not.toBe(parseFailMsg);

    // ACCEPT：对上了就没有 unmatched，否则「永远漏判」满足上两条。
    const ok = dispositionParseDiag(["f57ehu1"], new Map([["f57ehu1", "fixed"]]));
    expect(ok.parsed).toEqual(["f57ehu1"]);
    expect(ok.unmatched).toEqual([]);
    const okMsg = formatDispositionParseDiag(ok);
    expect(okMsg).toContain("f57ehu1");
    expect(okMsg).toMatch(/对不上：\(none\)/);
  });

  test("★ CJK 冒号行解析后不得再漏判（#6064 实盘）", () => {
    const report = [
      "总结",
      "",
      "Prior findings:",
      "- [fixed] f57ehu1：理由如此如此，已修",
      "",
      "Full review comments:",
      "",
      "(none)",
    ].join("\n");
    const dispositions = parsePriorDispositions(report);
    const diag = dispositionParseDiag(["f57ehu1"], dispositions);
    expect(diag.parsed).toEqual(["f57ehu1"]);
    expect(diag.unmatched).toEqual([]);
    const priorFinding: StateFinding = {
      id: "f57ehu1",
      severity: "P1",
      title: "t",
      file: "x.ts",
      line: "1",
    };
    expect(convergence([priorFinding], dispositions, []).unadjudicated).toEqual([]);
  });

  test("★ 漏判 sticky 必须带 parsed vs expected（#6064）", () => {
    // stderr 有诊断、PR sticky 没有 → 「reviewer 没写」与「写了但解析没对上」在评论上同色。
    const parseDiag = {
      expected: ["f57ehu1"],
      parsed: ["f57ehu1：已修"],
      unmatched: ["f57ehu1"],
    };
    const body = renderReviewComment({
      reviewerEngine: "codex",
      subjectEngine: "claude",
      sha: "a".repeat(40),
      base: "origin/main",
      findings: [],
      round: 2,
      convergence: {
        converged: false,
        unadjudicated: ["f57ehu1"],
        open: [],
        regressed: [],
        newP1: [],
        deferred: [],
      },
      parseDiag,
    });
    expect(body).toContain("f57ehu1");
    expect(body).toContain("f57ehu1：已修");
    expect(body).toMatch(/期望上一轮 id/);
    expect(body).toMatch(/解析出的判定 id/);
    for (const line of body.split("\n")) {
      if (line.includes("期望上一轮 id") || line.includes("解析出的判定 id")) {
        expect(line.startsWith("     ")).toBe(false);
      }
    }
  });

  test("★ 漏判但无 parseDiag 时不得捏造 parsed:[]（#6064）", () => {
    // 缺 parseDiag 时用 new Map() 会打印「解析出的判定 id：(none)」——那是「观察到空解析」，
    // 不是「没诊断」。未提供与空解析必须不同色。
    const body = renderReviewComment({
      reviewerEngine: "codex",
      subjectEngine: "claude",
      sha: "a".repeat(40),
      base: "origin/main",
      findings: [],
      round: 2,
      convergence: {
        converged: false,
        unadjudicated: ["f57ehu1"],
        open: [],
        regressed: [],
        newP1: [],
        deferred: [],
      },
    });
    expect(body).not.toContain("解析出的判定 id：(none)");
    expect(body).toMatch(/判定诊断不可用/);
  });

  test("★ ACCEPT：无漏判时 sticky 不强制带 parse diag（否则永远带上满足上一条）", () => {
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
      parseDiag: {
        expected: ["f57ehu1"],
        parsed: ["ghost-parsed"],
        unmatched: [],
      },
    });
    expect(body).not.toContain("ghost-parsed");
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

describe("★★ Gate 6 coder 引擎是集合，不是每 PR 一个值（#6184）", () => {
  const body = (e?: string) =>
    `> 🤖 AI Agent PR @ h · runner:x · agentloop@0.36.0+a · skill:x${e ? ` · engine:${e}` : ""}`;

  test("ACCEPT：单引擎行为完全不变 — 同引擎 BLOCKED、异引擎 PASS", () => {
    // 一个「永远判 BLOCKED」的闸满足所有「它拦住了同引擎 review」的断言。
    expect(crossEngineVerdict("claude", "claude")).toMatchObject({
      ok: false,
      reason: "same-engine",
    });
    expect(crossEngineVerdict("codex", "claude")).toMatchObject({
      ok: true,
      reason: "cross-engine",
    });
    expect(agentAuthored(body("claude"))).toMatchObject({
      required: true,
      coderEngine: "claude",
    });
    expect(reviewResult({ reviewerEngine: "claude", subjectEngine: "claude", findings: [] })).toBe(
      "BLOCKED",
    );
    expect(reviewResult({ reviewerEngine: "codex", subjectEngine: "claude", findings: [] })).toBe(
      "PASS",
    );
  });

  test("★ 身份行 engine:grok-build+claude 解析成集合，不是只取第一个", () => {
    const a = agentAuthored(body("grok-build+claude"));
    expect(a.coderEngines).toEqual(["grok-build", "claude"]);
    expect(a.coderEngine).toBe("grok-build+claude");
  });

  test("★ 多个 engine: 字段同样收成集合", () => {
    const line =
      "> 🤖 AI Agent PR @ h · runner:x · agentloop@0.36.0+a · skill:x · engine:grok-build · engine:claude";
    expect(agentAuthored(line).coderEngines).toEqual(["grok-build", "claude"]);
  });

  test("★ 混合作者：reviewer ∈ 集合 → same-engine BLOCKED，∉ 集合 → PASS", () => {
    const mixed = "grok-build+claude";
    expect(crossEngineVerdict("grok-build", mixed)).toMatchObject({
      ok: false,
      reason: "same-engine",
    });
    expect(crossEngineVerdict("claude", mixed)).toMatchObject({
      ok: false,
      reason: "same-engine",
    });
    expect(crossEngineVerdict("codex", mixed)).toMatchObject({
      ok: true,
      reason: "cross-engine",
    });
  });

  test("★ reviewResult：grok 审混合作者 BLOCKED，codex 审 PASS", () => {
    expect(
      reviewResult({
        reviewerEngine: "grok-build",
        subjectEngine: "grok-build+claude",
        findings: [],
      }),
    ).toBe("BLOCKED");
    expect(
      reviewResult({
        reviewerEngine: "codex",
        subjectEngine: "grok-build+claude",
        findings: [],
      }),
    ).toBe("PASS");
  });

  test("★ 追加而不是覆盖：grok 写完 claude 再写，claim 集合保住 grok-build", () => {
    const afterGrok = body("grok-build");
    const afterClaude = appendCoderEngine(afterGrok, "claude");
    const claim = coderEngineClaim(undefined, afterClaude);
    expect(claim.engine).toBe("grok-build+claude");
    expect(agentAuthored(afterClaude).coderEngines).toEqual(["grok-build", "claude"]);
    expect(crossEngineVerdict("grok-build", claim.engine).ok).toBe(false);
    expect(crossEngineVerdict("codex", claim.engine).ok).toBe(true);
  });

  test("mutation: 把追加改回覆盖 → grok reviewer 假 PASS，断言必须红", () => {
    const src = readFileSync(new URL("./local-review.ts", import.meta.url), "utf8");
    expect(src).toMatch(/unionCoderEngines/);
    // 真追加：集合是 {grok-build, claude}，grok reviewer BLOCKED。
    const appended = unionCoderEngines(["grok-build"], "claude");
    expect(appended).toEqual(["grok-build", "claude"]);
    expect(crossEngineVerdict("grok-build", appended.join("+")).ok).toBe(false);
    // 覆盖（本条修法要根除的形态）：集合掉成 {claude}，grok reviewer 假 PASS。
    const overwrite = (prior: string[], next: string) => (next ? [next] : prior);
    const dropped = overwrite(["grok-build"], "claude");
    expect(dropped).toEqual(["claude"]);
    expect(crossEngineVerdict("grok-build", dropped.join("+")).ok).toBe(true);
    // 源里必须是追加。改成 `return n ? [n] : [...prior]`（覆盖）会让上面那条
    // 真追加断言红 —— 把实现改坏时本测试必须失败。
    expect(src).toMatch(/return prior\.includes\(n\) \? \[\.\.\.prior\] : \[\.\.\.prior, n\];/);
    expect(src).not.toMatch(/return n \? \[n\] : \[\.\.\.prior\];/);
  });

  test("★ --subject-engine 只能确认集合里的一员，不得把集合塌成单值", () => {
    const mixed = body("grok-build+claude");
    const r = resolveSubjectEngine(mixed, "claude");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.engine).toBe("grok-build+claude");
    expect(crossEngineVerdict("grok-build", r.engine).ok).toBe(false);
  });

  test("★ attested 顺序派工的集合与 claimed 子集不矛盾，用完整 attested 集", () => {
    const c = coderEngineClaim("grok-build+claude", body("claude"));
    expect(c.conflict).toBeUndefined();
    expect(c.attested).toBe(true);
    expect(c.engine).toBe("grok-build+claude");
    expect(crossEngineVerdict("grok-build", c.engine).ok).toBe(false);
  });

  test("★ claimed 侧单值不得因为 attested 放宽而变松：只有 claimed 时仍是单元素", () => {
    const c = coderEngineClaim(undefined, body("claude"));
    expect(c.attested).toBe(false);
    expect(c.engine).toBe("claude");
    expect(c.source).toBe("pr-body");
    expect(crossEngineVerdict("codex", c.engine).ok).toBe(true);
  });

  test("★ pickDefaultReviewer 对混合作者挑一个不在集合里的引擎", () => {
    const picked = pickDefaultReviewer("grok-build+claude");
    expect(picked).toBeDefined();
    expect(["grok-build", "claude"]).not.toContain(picked);
    expect(crossEngineVerdict(picked, "grok-build+claude").ok).toBe(true);
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

  test("★★ FAIL 的失败详情必须说「先修，别重跑」—— 提示自己是 #6255 循环的引擎", () => {
    const failed = renderReviewComment({
      reviewerEngine: "codex",
      subjectEngine: "claude",
      sha: SHA40,
      base: "origin/main",
      round: 1,
      findings: [{ severity: "P1", title: "真问题", file: "a.ts", line: "1", body: "详情" }],
    });
    const r = requireLocalReviewSticky(
      "6255",
      SHA40,
      "bun …/local-review.ts --pr 6255 --post",
      runnerOf({ body: failed, user: { login: "coder" } }),
      { prAuthor: "coder", coderEngine: "claude" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/重跑不会改变它/);
  });
});

describe("★★ rerunDiscipline —— 「该重跑」与「重跑没有用」必须分色", () => {
  const marker = (result: string, round: number) =>
    `<!-- local-review sha=${SHA40} result=${result} -->\n` +
    `<!-- local-review-state {"round":${round},"findings":[]} -->\n## 本地 review`;

  test("★ ACCEPT：sha 陈旧但判决 PASS、轮次未到顶 —— 这次确实该重跑，不加噪音", () => {
    // 正控：这个函数必须**有沉默的时候**。一个对每种失败都开口的实现，
    // 与一个真的在区分的实现，在「FAIL 时有提示」这条断言上完全同色。
    expect(rerunDiscipline(marker("PASS", 1))).toBeUndefined();
  });

  test("★ FAIL ⇒ 先修 findings", () => {
    expect(rerunDiscipline(marker("FAIL", 1))).toMatch(/重跑不会改变它/);
  });

  test("★ 到顶 ⇒ 停止重跑、交给人（第 4 轮不会变绿）", () => {
    const d = rerunDiscipline(marker("BLOCKED", ROUND_CAP));
    expect(d).toMatch(/escalate/);
    expect(d).toMatch(new RegExp(`第 ${ROUND_CAP} 轮`));
  });

  test("★★ 到顶但已 PASS ⇒ 沉默：这时闸红的原因是 sha 陈旧，正确动作就是重跑", () => {
    // 只看 round 会在这里说「到顶了，停止重跑，交给人」——把一次正常的增量复审
    // 误导成升级。第 3 轮收敛成 PASS、之后又推了一个 commit，是完全正常的形态。
    expect(rerunDiscipline(marker("PASS", ROUND_CAP))).toBeUndefined();
    expect(rerunDiscipline(marker("PASS", ROUND_CAP + 2))).toBeUndefined();
  });

  test("★ 读不到 result 但已到顶 ⇒ 仍然按未收敛处理（不知道 ≠ 收敛过）", () => {
    const noResult = `<!-- local-review sha=${SHA40} -->\n<!-- local-review-state {"round":${ROUND_CAP},"findings":[]} -->`;
    expect(rerunDiscipline(noResult)).toMatch(/escalate/);
  });

  test("★ 边界取 >=：ROUND_CAP 那一轮本身就到顶", () => {
    // 同 reviewResultForRound 的 `>=` 边界（#5697 P2）：声明的上限必须在它自己
    // 那一轮生效，否则「到顶了」与「还没到顶」在边界那一轮同色。
    expect(rerunDiscipline(marker("BLOCKED", ROUND_CAP - 1))).toBeUndefined();
    expect(rerunDiscipline(marker("BLOCKED", ROUND_CAP))).toBeDefined();
  });

  test("★ 两条同时成立时都要说 —— FAIL 且到顶", () => {
    const d = rerunDiscipline(marker("FAIL", ROUND_CAP));
    expect(d).toMatch(/重跑不会改变它/);
    expect(d).toMatch(/escalate/);
  });

  test("★ 读不到 body ⇒ 沉默（不猜）", () => {
    expect(rerunDiscipline(undefined)).toBeUndefined();
    expect(rerunDiscipline("")).toBeUndefined();
  });
});

/**
 * arc#6165 + #6172 —— 解析失败这条路上的两个同色洞。
 *
 * #6165: sticky 把「有两条真 P2」和「reviewer 什么都没说」都渲染成 `BLOCKED · 0 条`。
 *         fail-closed（BLOCKED）是对的；绞死已经认得出的 finding 是错的。
 * #6172: grok-build 的模型原文有时落盘、有时只剩 24 行日志。文件存在 ≠ 原文还在；
 *         「什么都没说」与「说了但扔掉」必须分色。依赖 #6183：身份行已经能写出
 *         `engine:grok-build`，否则独立性会先被涂成 unknown，本条的分色到不了人眼前。
 */
describe("★★ arc#6165 + #6172 —— 解析失败不得绞死 finding / 原文不得同色丢失", () => {
  const NONCE = "arc-review-nonce-6165dead";
  const SHA = "a".repeat(40);
  /** PR #6135 上 grok-build 那份格式完好、却被渲染成 0 条的形状。 */
  const wellFormedTwoP2s = [
    "先看完整 diff 和调用链。",
    "",
    "Full review comments:",
    "",
    "- [P2] record-building catch leaves ledgerWrites absent on a reachable path — packages/core/src/audit.ts:40-55",
    "  catch 吞掉异常之后返回值没有 ledgerWrites，下游当成没写过。",
    "- [P2] { success: false } hub result with no tokens counted as skipped — packages/core/src/audit.ts:80-90",
    "  writeAuditEntry 从不读 result.success，后端故障与图片 hub 正常工作同色。",
  ].join("\n");

  test("★ arc#6165 REJECT: 格式完好的 finding + 缺 nonce → 仍 unparseable，但 findings 必须捞回", () => {
    // 脚本每轮都传 nonce。grok 常漏抄最后一行，于是整份在 nonce 检查处被扔掉，
    // 两条 P2 只剩在 raw 文件里。fail-closed 是 BLOCKED，不是「当 0 条」。
    const r = parseCodexReview(wellFormedTwoP2s, { nonce: NONCE });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("incomplete");
    expect(r.findings.length).toBe(2);
    expect(r.findings[0]?.title).toContain("ledgerWrites");
    expect(r.findings[1]?.title).toContain("success: false");
    expect(r.excerpt).toContain("ledgerWrites");
  });

  test("★ arc#6165 REJECT: 没有小节 vs 有小节但认不出 —— kind 必须分色", () => {
    const noSection = parseCodexReview("已检查完整 diff，未发现可确证问题。");
    expect(noSection.ok).toBe(false);
    if (noSection.ok) return;
    expect(noSection.kind).toBe("missing-section");

    const unrecognised = parseCodexReview(
      "S\n\nFull review comments:\n\n1. 这不是契约形状的 finding\n",
    );
    expect(unrecognised.ok).toBe(false);
    if (unrecognised.ok) return;
    expect(unrecognised.kind).toBe("unrecognised");
    expect(unrecognised.kind).not.toBe(noSection.kind);
  });

  test("★ arc#6165 REJECT: sticky 有捞回的 P2 时不得写成 0 条", () => {
    const parsed = parseCodexReview(wellFormedTwoP2s, { nonce: NONCE });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const body = renderReviewComment({
      reviewerEngine: "grok-build",
      subjectEngine: "claude",
      sha: SHA,
      base: "origin/main",
      findings: parsed.findings,
      unparseable: true,
      parseKind: parsed.kind,
      excerpt: parsed.excerpt,
      raw: {
        path: ".verify/local-review-6135.raw.md",
        bytes: wellFormedTwoP2s.length,
        preserved: true,
      },
    });
    expect(body.split("\n")[0]).toContain("result=BLOCKED");
    expect(body).toMatch(/2 条/);
    expect(body).not.toMatch(/0 条/);
    expect(body).toContain("ledgerWrites");
    expect(body).toContain("success: false");
    expect(body).toMatch(/无法解析/);
    expect(body).toMatch(/原文已保留/);
    expect(body).toContain(".verify/local-review-6135.raw.md");
  });

  test("★ arc#6165 ACCEPT: 真干净仍是 PASS · 0 条（否则「永远非 0 条」满足上一条）", () => {
    const clean = ["Looks good.", "", "Full review comments:", "", "(none)", "", NONCE].join("\n");
    const r = parseCodexReview(clean, { nonce: NONCE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings.length).toBe(0);
    const body = renderReviewComment({
      reviewerEngine: "codex",
      subjectEngine: "claude",
      sha: SHA,
      base: "origin/main",
      findings: r.findings,
    });
    expect(body.split("\n")[0]).toContain("result=PASS");
    expect(body).toMatch(/0 条/);
    expect(body).toMatch(/本轮无 finding/);
  });

  test("★ arc#6165 ACCEPT: 解析失败仍是 BLOCKED，不得因为捞回了 finding 就变 FAIL/PASS", () => {
    expect(
      reviewResult({
        reviewerEngine: "grok-build",
        subjectEngine: "claude",
        findings: [
          {
            severity: "P2",
            title: "ledgerWrites absent",
            file: "a.ts",
            line: "1",
            body: "x",
          },
        ],
        unparseable: true,
      }),
    ).toBe("BLOCKED");
  });

  test("★ arc#6172 REJECT: stdout 空、stderr 有模型原文 → 接到的是 stderr（grok-build 洞）", () => {
    const model = `${wellFormedTwoP2s}\n`;
    const collected = collectReviewOutput({
      outputMode: "stdout",
      stdout: "",
      stderr: model,
    });
    expect(collected.source).toBe("stderr");
    expect(collected.text).toContain("ledgerWrites");
  });

  test("★ arc#6172 ACCEPT: stdout 非空时不得改吃 stderr（事件流/日志不能冒充模型原文）", () => {
    const collected = collectReviewOutput({
      outputMode: "stdout",
      stdout: "Full review comments:\n\n(none)\n",
      stderr: wellFormedTwoP2s,
    });
    expect(collected.source).toBe("stdout");
    expect(collected.text).toContain("(none)");
    expect(collected.text).not.toContain("ledgerWrites");
  });

  test("★ arc#6172 ACCEPT: file 模式优先 outFile（codex -o），stdout 只是回退", () => {
    const collected = collectReviewOutput({
      outputMode: "file",
      stdout: "event stream noise",
      stderr: "",
      outFileText: wellFormedTwoP2s,
    });
    expect(collected.source).toBe("outFile");
    expect(collected.text).toContain("ledgerWrites");
  });

  test("★ arc#6172 REJECT: 空原文 persist.preserved=false —— 文件存在不是原文还在", () => {
    // 铁律：一个「总是创建 raw 文件」的实现满足每一条「raw 被保留了」的断言。
    const dir = mkdtempSync(join(tmpdir(), "local-review-6172-"));
    try {
      const dest = join(dir, "empty.raw.md");
      const artifact = formatReviewRawArtifact(
        collectReviewOutput({ outputMode: "stdout", stdout: "", stderr: "" }),
        { engine: "grok-build" },
      );
      const r = persistReviewRaw({ destPath: dest, modelText: "", artifact });
      expect(r.preserved).toBe(false);
      expect(r.bytes).toBe(0);
      const onDisk = readFileSync(dest, "utf8");
      // 盘上可以有头，但不得把空原文涂成「已保留」。
      expect(onDisk).not.toContain("ledgerWrites");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("★ arc#6172 ACCEPT: 文件里必须真的含模型说过的话，不只是文件存在", () => {
    const dir = mkdtempSync(join(tmpdir(), "local-review-6172-"));
    try {
      const dest = join(dir, "kept.raw.md");
      const collected = collectReviewOutput({
        outputMode: "stdout",
        stdout: "",
        stderr: wellFormedTwoP2s,
      });
      const artifact = formatReviewRawArtifact(collected, { engine: "grok-build" });
      const r = persistReviewRaw({
        destPath: dest,
        modelText: collected.text,
        artifact,
      });
      expect(r.preserved).toBe(true);
      expect(r.bytes).toBeGreaterThan(0);
      const onDisk = readFileSync(r.path, "utf8");
      expect(onDisk).toContain("ledgerWrites");
      expect(onDisk).toContain("success: false");
      expect(onDisk).toContain("engine: grok-build");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("★ arc#6172 REJECT: sticky 上「原文已保留」与「原文未保留」必须分色", () => {
    const base = {
      reviewerEngine: "grok-build",
      subjectEngine: "claude",
      sha: SHA,
      base: "origin/main",
      findings: [] as ReviewFinding[],
      unparseable: true,
      parseKind: "empty" as const,
    };
    const kept = renderReviewComment({
      ...base,
      excerpt: reviewExcerpt("模型说了一段话但解析器没认出来"),
      raw: { path: ".verify/kept.raw.md", bytes: 99, preserved: true },
    });
    const lost = renderReviewComment({
      ...base,
      excerpt: "",
      raw: { path: ".verify/lost.raw.md", bytes: 0, preserved: false },
    });
    expect(kept).toMatch(/原文已保留/);
    expect(kept).toContain(".verify/kept.raw.md");
    expect(kept).toContain("模型说了一段话但解析器没认出来");
    expect(lost).toMatch(/原文未保留/);
    expect(lost).not.toMatch(/原文已保留/);
    expect(kept).not.toBe(lost);
  });

  test("★ 脚本必须在解析之前无条件落盘，且 stdout+stderr 都 pipe（#6172 接线）", () => {
    const src = readFileSync(new URL("../scripts/local-review.ts", import.meta.url), "utf8");
    expect(src).toContain("persistReviewRaw");
    expect(src).toContain("collectReviewOutput");
    // 修之前 stderr 是 inherit、file 模式 stdout 也是 inherit —— grok 的模型原文
    // 只要没打到被 pipe 的那条 fd 就丢了。两条都 pipe 才是无条件。
    expect(src).toMatch(/stdio:\s*\[[^\]]*pipe[^\]]*pipe/);
    expect(src).not.toMatch(/outputMode === "stdout" \? "pipe" : "inherit"/);
    // persist 必须在 parse 之前。把两行调换会让「解析崩了原文没落」再出现。
    expect(src.indexOf("persistReviewRaw(")).toBeLessThan(src.indexOf("parseCodexReview("));
  });
});

describe("★★ cwd HEAD 必须是 PR head，否则不得 spawn（arc#6195）", () => {
  /**
   * 事故原形：`local-review.ts --pr 6112` 从共享主 checkout 跑，当时 HEAD 是另一条
   * 分支。reviewer 认真审了 `scripts/git-push-lease.ts`，输出带 nonce、格式合法，
   * 却一个 native 文件都没看见。`--post` 路径后来有 sha 断言，但在引擎跑完之后
   * 才做（实测烧掉 1288s）；**不带 `--post` 时完全没有这条断言**。
   *
   * nonce 证明输出没被截断，不证明输入是对的。「审过这个 PR」与「审的是别的东西」
   * 在报告上同色。
   */
  const LOCAL = "4e5add2adba71226880fb411664d749de35f1cd3";
  const PR_HEAD = "13ac17cd2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const CWD = "/Users/robmao/work/arcblock/arc";
  const ghHead =
    (out: string, code = 0) =>
    (cmd: string) => {
      expect(cmd).toMatch(/6112/);
      expect(cmd).toMatch(/head\.sha|headRefOid/);
      return { code, out, ms: 0 };
    };

  test("★ REJECT: sha 不符 → 非 ok，两个 sha 和 cwd 都要说出来", () => {
    const r = assertCwdIsPrHead({
      pr: "6112",
      localSha: LOCAL,
      cwd: CWD,
      runner: ghHead(`${PR_HEAD}\n`),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain(LOCAL);
    expect(r.reason).toContain(PR_HEAD);
    expect(r.reason).toContain(CWD);
    expect(r.reason).toMatch(/worktree|工作树/);
    // 一个「只警告、仍 ok」的实现会让调用方照常 spawn —— 那正是事故。
  });

  test("★ REJECT: 取不到 PR head ≠ 就是当前 HEAD（读不到不得放行）", () => {
    const r = assertCwdIsPrHead({
      pr: "6112",
      localSha: LOCAL,
      cwd: CWD,
      runner: ghHead("not a sha", 1),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/取不到|读不到|head/i);
    expect(r.reason).toContain("6112");
    // 判别项：退回 localSha 当 PR head 的实现会 ok=true。
  });

  test("★ REJECT: gh 成功但输出空 / 非 40 位 → 同样停，不猜", () => {
    for (const out of ["", "13ac17cd2", "HEAD", "origin/main"]) {
      const r = assertCwdIsPrHead({
        pr: "6112",
        localSha: LOCAL,
        cwd: CWD,
        runner: ghHead(out),
      });
      expect(r.ok).toBe(false);
    }
  });

  test("★ ACCEPT: sha 相符 → ok，调用方应照常 review（否则「永远拒绝」满足上面每一条）", () => {
    let fetched = false;
    const r = assertCwdIsPrHead({
      pr: "6112",
      localSha: PR_HEAD,
      cwd: "/workspace/wt/pr-6112",
      runner: (cmd) => {
        fetched = true;
        expect(cmd).toMatch(/6112/);
        return { code: 0, out: `${PR_HEAD}\n`, ms: 0 };
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sha).toBe(PR_HEAD);
    expect(r.prHead).toBe(PR_HEAD);
    expect(fetched).toBe(true);
  });

  test("★ 正控：相符与不符必须不同色（否则上面几条可能只是同向）", () => {
    const mismatch = assertCwdIsPrHead({
      pr: "6112",
      localSha: LOCAL,
      cwd: CWD,
      runner: ghHead(PR_HEAD),
    });
    const match = assertCwdIsPrHead({
      pr: "6112",
      localSha: PR_HEAD,
      cwd: "/wt/pr-6112",
      runner: ghHead(PR_HEAD),
    });
    expect(mismatch.ok).toBe(false);
    expect(match.ok).toBe(true);
    expect(mismatch.ok).not.toBe(match.ok);
  });

  test("★ 脚本必须在 spawn 之前断言，且不藏在 --post 里", () => {
    const src = readFileSync(new URL("../scripts/local-review.ts", import.meta.url), "utf8");
    expect(src).toContain("assertCwdIsPrHead");
    const assertAt = src.indexOf("assertCwdIsPrHead(");
    const spawnAt = src.indexOf("spawnSync(");
    // 锚在控制流，不是注释里的「if (post)」字样。
    const postAt = src.indexOf("if (post) {");
    expect(assertAt).toBeGreaterThan(0);
    expect(spawnAt).toBeGreaterThan(assertAt);
    // 修之前断言只在 `--post` 分支里。把检查重新塞进该分支，不带 --post
    // 的错 review 再与真 review 同色。
    expect(postAt).toBeGreaterThan(0);
    expect(assertAt).toBeLessThan(postAt);
  });
});

/**
 * arc#6187 —— codex 对报告契约的遵守是间歇性的。
 *
 * #6123 把「输出无法解析」判成 BLOCKED 是对的（散文结论与「我没能审」同色）。
 * 但引擎对契约的遵守不稳：平凡 diff（纯配置 / 纯文档）上，codex 稳定只出一句
 * 对话式结论，没有小节头、没有 `(none)`、没有 nonce → 可合并的 PR 被随机挡住。
 *
 * 修法不是把散文重新读成干净（那会把 #6123 整段退回去），而是让契约兑现
 * 不再靠模型自觉在自由文本末尾贴哨兵：
 *
 *   1. 结构化输出（JSON schema）—— 格式由引擎强制，不由被审方自觉
 *   2. 一次「你没有按契约输出」重试，仍不合规才 BLOCKED
 *
 * 误拦一侧不可少：真有 P1 的报告修好之后仍必须报出那条 P1，不得变成 PASS。
 */
describe("★★ arc#6187 —— 契约兑现不得靠模型自觉贴哨兵", () => {
  const NONCE = "arc-review-nonce-6187deadbeef";
  const PROSE_6186 = readFileSync(
    new URL("./fixtures/codex-prose-6186.txt", import.meta.url),
    "utf8",
  ).trim();
  const markdownClean = [
    "审完了，没问题。",
    "",
    "Full review comments:",
    "",
    "(none)",
    "",
    NONCE,
  ].join("\n");
  const markdownP1 = [
    "有一个确证的缺陷。",
    "",
    "Full review comments:",
    "",
    "- [P1] 错误放行 — packages/core/src/afs.ts:7",
    "  只有在 X 且 Y 时才会触发，修法是 Z。",
    "",
    NONCE,
  ].join("\n");
  const jsonClean = JSON.stringify({
    summary: "已审查完整 diff，未发现可确证的缺陷。",
    findings: [],
    nonce: NONCE,
  });
  const jsonP1 = JSON.stringify({
    summary: "有一个确证的缺陷。",
    findings: [
      {
        severity: "P1",
        title: "错误放行",
        file: "packages/core/src/afs.ts",
        line: "7",
        body: "只有在 X 且 Y 时才会触发，修法是 Z。",
      },
    ],
    nonce: NONCE,
  });
  const verdict = (parsed: ReturnType<typeof parseReviewReport>) =>
    reviewResult({
      reviewerEngine: "codex",
      subjectEngine: "claude",
      findings: parsed.ok ? parsed.findings : [],
      unparseable: !parsed.ok,
    });

  test("★ REJECT: #6186 那种平凡 diff 散文仍是 unparseable，不是干净", () => {
    // 这条钉死 #6123 不许被「修合规率」顺手退回去。
    expect(PROSE_6186).toMatch(/未发现/);
    expect(PROSE_6186).not.toContain("Full review comments:");
    expect(PROSE_6186).not.toContain("(none)");
    expect(parseReviewReport(PROSE_6186, { nonce: NONCE }).ok).toBe(false);
    expect(parseReviewReport(`${PROSE_6186}\n\n${NONCE}`, { nonce: NONCE }).ok).toBe(false);
    expect(verdict(parseReviewReport(PROSE_6186, { nonce: NONCE }))).toBe("BLOCKED");
  });

  test("★ ACCEPT: 结构化 JSON 空 findings + 匹配 nonce → PASS，零条", () => {
    const r = parseReviewReport(jsonClean, { nonce: NONCE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings).toEqual([]);
    expect(verdict(r)).toBe("PASS");
  });

  test("★ REJECT: JSON 缺 nonce / nonce 不对 / 没有 findings 数组 → unparseable，不是干净", () => {
    expect(
      parseReviewReport(JSON.stringify({ summary: "ok", findings: [] }), { nonce: NONCE }).ok,
    ).toBe(false);
    expect(
      parseReviewReport(JSON.stringify({ summary: "ok", findings: [], nonce: "other" }), {
        nonce: NONCE,
      }).ok,
    ).toBe(false);
    expect(parseReviewReport(JSON.stringify({ ok: true, nonce: NONCE }), { nonce: NONCE }).ok).toBe(
      false,
    );
    expect(verdict(parseReviewReport(JSON.stringify({ ok: true }), { nonce: NONCE }))).toBe(
      "BLOCKED",
    );
  });

  test("★ 误拦：JSON 里的真 P1 必须报出，判决 FAIL 不是 PASS/干净", () => {
    const r = parseReviewReport(jsonP1, { nonce: NONCE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      severity: "P1",
      title: "错误放行",
      file: "packages/core/src/afs.ts",
      line: "7",
    });
    expect(r.findings[0]?.body).toContain("修法是 Z");
    // 有 finding 是 FAIL（闸仍挡住合并）。BLOCKED 是「没审成」；两者不许同色。
    expect(verdict(r)).toBe("FAIL");
  });

  test("★ REJECT: JSON findings 缺字段 → unparseable，不许丢条装干净", () => {
    const bad = JSON.stringify({
      summary: "有问题",
      findings: [{ severity: "P1", title: "x" }],
      nonce: NONCE,
    });
    expect(parseReviewReport(bad, { nonce: NONCE }).ok).toBe(false);
    expect(verdict(parseReviewReport(bad, { nonce: NONCE }))).toBe("BLOCKED");
  });

  test("★ 重试：平凡散文之后按契约重出 → PASS 空 findings", () => {
    const r = fulfillReviewContract({
      nonce: NONCE,
      first: { stdout: PROSE_6186, failed: false },
      retry: () => ({ stdout: markdownClean, failed: false }),
    });
    expect(r.retried).toBe(true);
    expect(r.parsed.ok).toBe(true);
    if (r.parsed.ok) expect(r.parsed.findings).toEqual([]);
    expect(verdict(r.parsed)).toBe("PASS");
  });

  test("★ 弄坏：去掉重试，同一条平凡 diff 散文再次不可解析 → BLOCKED", () => {
    const r = fulfillReviewContract({
      nonce: NONCE,
      first: { stdout: PROSE_6186, failed: false },
    });
    expect(r.retried).toBe(false);
    expect(r.parsed.ok).toBe(false);
    expect(verdict(r.parsed)).toBe("BLOCKED");
  });

  test("★ 弄坏：重试仍是散文 → 仍 BLOCKED，不得读成干净", () => {
    const r = fulfillReviewContract({
      nonce: NONCE,
      first: { stdout: PROSE_6186, failed: false },
      retry: () => ({ stdout: PROSE_6186, failed: false }),
    });
    expect(r.retried).toBe(true);
    expect(r.parsed.ok).toBe(false);
    expect(verdict(r.parsed)).toBe("BLOCKED");
  });

  test("★ REJECT: 进程失败不重试（超时/非零 ≠ 散文不合规）", () => {
    const r = fulfillReviewContract({
      nonce: NONCE,
      first: { stdout: "", failed: true },
      retry: () => ({ stdout: markdownClean, failed: false }),
    });
    expect(r.retried).toBe(false);
    expect(r.failed).toBe(true);
    expect(r.parsed.ok).toBe(false);
  });

  test("★ 重试提示必须点名「没按契约」，并带上 (none) 与 nonce", () => {
    const p = contractRetryPrompt(NONCE);
    expect(p).toMatch(/没按契约|没有按契约|无法解析/);
    expect(p).toContain("(none)");
    expect(p).toContain(NONCE);
    expect(p).toContain("Full review comments:");
  });

  test("★ 结构化 schema 是严格 JSON Schema（additionalProperties: false + required）", () => {
    expect(REVIEW_OUTPUT_SCHEMA.type).toBe("object");
    expect(REVIEW_OUTPUT_SCHEMA.additionalProperties).toBe(false);
    expect(REVIEW_OUTPUT_SCHEMA.required).toEqual(["summary", "findings", "nonce"]);
    expect(REVIEW_OUTPUT_SCHEMA.properties.findings.type).toBe("array");
    const item = REVIEW_OUTPUT_SCHEMA.properties.findings.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(["severity", "title", "file", "line", "body"]);
  });

  test("★ 弄坏：去掉 --output-schema 请求，模拟 codex 在平凡 diff 上再次只出散文", () => {
    setReviewerEngines({
      ...FIXTURE,
      codex: {
        bin: "codex",
        args: ({
          prompt,
          outFile,
          schemaFile,
        }: {
          prompt: string;
          base: string;
          outFile?: string;
          schemaFile?: string;
        }) => [
          "exec",
          "-s",
          "read-only",
          ...(outFile ? ["-o", outFile] : []),
          ...(schemaFile ? ["--output-schema", schemaFile] : ["review"]),
          prompt,
        ],
        outputMode: "file" as const,
      },
    });
    const simulate = (argv: string[]) =>
      argv.includes("--output-schema") ? jsonClean : PROSE_6186;

    const withSchema = reviewerArgv("codex", {
      prompt: "p",
      base: "main",
      outFile: "/tmp/o",
      schemaFile: "/tmp/s.json",
    });
    expect(withSchema).toContain("--output-schema");
    const parsed = parseReviewReport(simulate(withSchema), { nonce: NONCE });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.findings).toEqual([]);
    expect(verdict(parsed)).toBe("PASS");

    const without = reviewerArgv("codex", { prompt: "p", base: "main", outFile: "/tmp/o" });
    expect(without).not.toContain("--output-schema");
    expect(parseReviewReport(simulate(without), { nonce: NONCE }).ok).toBe(false);
    expect(verdict(parseReviewReport(simulate(without), { nonce: NONCE }))).toBe("BLOCKED");
  });

  test("★ ACCEPT: grok-build / claude 的 markdown 契约路径不得被改坏", () => {
    const clean = parseReviewReport(markdownClean, { nonce: NONCE });
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.findings).toEqual([]);
    expect(verdict(clean)).toBe("PASS");

    const p1 = parseReviewReport(markdownP1, { nonce: NONCE });
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    expect(p1.findings).toHaveLength(1);
    expect(p1.findings[0]?.severity).toBe("P1");
    expect(verdict(p1)).toBe("FAIL");

    const f = fulfillReviewContract({
      nonce: NONCE,
      first: { stdout: markdownClean, failed: false },
      retry: () => {
        throw new Error("must not retry a parseable report");
      },
    });
    expect(f.retried).toBe(false);
    expect(f.parsed.ok).toBe(true);
  });
});
