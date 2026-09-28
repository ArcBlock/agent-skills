import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { makeMarker } from "./comment.ts";
import { type GateFail, type GatePass, requireStickyGate } from "./gate.ts";
import { stripAnsi } from "./report.ts";
/**
 * 本地 reviewer —— 在 **coder 自己的工作树里**跑一个**不同类型**的 agent 做 review。
 *
 * ## 为什么在同一棵树里
 *
 * 树已经在被审的 SHA 上、`node_modules` 已经装好。另开一棵树意味着一次 clone + 一次
 * install，而 review 是每个 PR 都要发生的事。这就是 coder 与 reviewer 同 worker 的
 * 全部理由——跨 worker 就等于跨树。只读沙箱不是可选项：能写就可能改坏被审的代码。
 *
 * ## 不变量：`reviewer.engine ∉ coderEngines`
 *
 * coder 引擎是**集合**（arc#6184），不是每条 PR 一个值。一条分支被两个引擎先后写过
 * 时，独立性是 reviewer 不在这个集合里，不是「跟正文里那一个字段不等」。
 * 唯一的硬约束是**引擎类型不同**，不是「哪个引擎当 reviewer」。codex 当 reviewer 是
 * 当前的测试配置，所以引擎走**注册表**——认不出的引擎抛错，绝不「认不出就当 codex」。
 *
 * 判决落在 merge 决策上，不落在 `code-agents/src/review.ts`：那里的 `reason` 是
 * **进程表的生命周期投影**，同引擎的 reviewer 确实在跑，让它说没在跑就是撒谎（#5352
 * 刻意让 lifecycle 与 independence 正交）。这里产出的 sticky comment 是 merge-gate
 * 第五道门的**输入**，格式因此是契约，不只是排版。
 */

export interface ReviewFinding {
  severity: string;
  title: string;
  file: string;
  line?: string;
  body: string;
}

/**
 * 解析失败的**颜色**。BLOCKED 是对的；把四种失败压成一句「无法解析 · 0 条」是错的
 * （arc#6165 / #6172）。
 *
 * - `empty`            模型原文一个字都没有
 * - `missing-section`  没有 `Full review comments:` 小节（codex 干净时常这样）
 * - `unrecognised`     有小节，但 finding 行认不出
 * - `incomplete`       结束标记（nonce）缺失 —— 输出可能被截断，但中间也许有真 finding
 */
export type UnparseableKind = "empty" | "missing-section" | "unrecognised" | "incomplete";

export type ParseFailure = {
  ok: false;
  reason: "unparseable";
  kind: UnparseableKind;
  /** 即使总体失败，已经认得出的 finding 也要带上 —— 绞死它们就是 #6165。 */
  findings: ReviewFinding[];
  excerpt: string;
};

export type ParseResult = { ok: true; findings: ReviewFinding[] } | ParseFailure;

export const REVIEW_EXCERPT_CAP = 1200;

/** 截断必须说出来。空串保持空，不拿占位符冒充原文。 */
export function reviewExcerpt(text: string, cap = REVIEW_EXCERPT_CAP): string {
  const t = text.trim();
  if (!t) return "";
  if (t.length <= cap) return t;
  return `${t.slice(0, cap)}\n… （原文 ${t.length} 字节，已截断）`;
}

function unparseable(
  kind: UnparseableKind,
  raw: string,
  findings: readonly ReviewFinding[] = [],
): ParseFailure {
  return {
    ok: false,
    reason: "unparseable",
    kind,
    findings: [...findings],
    excerpt: reviewExcerpt(raw),
  };
}

export interface CollectedReviewOutput {
  /** 交给解析器的那一份 —— 模型原文，不是事件流。 */
  text: string;
  stdout: string;
  stderr: string;
  outFileText: string;
  source: "outFile" | "stdout" | "stderr" | "empty";
}

/**
 * 从引擎的三条管子里挑模型原文。
 *
 * grok-build / claude 声明 `outputMode: "stdout"`，但实测 grok 有时把答案打到
 * stderr，stdout 是空的（#6172：24 行日志、无模型输出）。只读声明的那条 fd，
 * 「什么都没说」与「说了但打到另一条管子」同色。
 *
 * 优先级：file 模式 outFile → stdout → stderr；stdout 模式 stdout → stderr。
 * **非空的首选赢**，避免把事件流/工具日志拼进解析器。
 */
export function collectReviewOutput(opts: {
  outputMode: "file" | "stdout";
  stdout: string;
  stderr: string;
  outFileText?: string;
}): CollectedReviewOutput {
  const stdout = opts.stdout ?? "";
  const stderr = opts.stderr ?? "";
  const outFileText = opts.outFileText ?? "";
  const pick = (): { text: string; source: CollectedReviewOutput["source"] } => {
    if (opts.outputMode === "file" && outFileText.trim()) {
      return { text: outFileText, source: "outFile" };
    }
    if (stdout.trim()) return { text: stdout, source: "stdout" };
    if (stderr.trim()) return { text: stderr, source: "stderr" };
    return { text: "", source: "empty" };
  };
  const { text, source } = pick();
  return { text, stdout, stderr, outFileText, source };
}

export function formatReviewRawArtifact(
  collected: CollectedReviewOutput,
  meta: { engine: string },
): string {
  const orEmpty = (s: string) => (s.trim() ? s : "(empty)");
  return [
    `# local-review raw · ${meta.engine}`,
    `engine: ${meta.engine}`,
    `source: ${collected.source}`,
    `bytes: ${Buffer.byteLength(collected.text, "utf8")}`,
    "",
    "## model",
    orEmpty(collected.text),
    "",
    "## stdout",
    orEmpty(collected.stdout),
    "",
    "## stderr",
    orEmpty(collected.stderr),
    "",
    "## outFile",
    orEmpty(collected.outFileText),
    "",
  ].join("\n");
}

export interface ReviewRawPersist {
  path: string;
  bytes: number;
  /** 模型原文非空 **且** 写盘成功。空文件 / 只有头 ≠ 已保留（#6172 铁律）。 */
  preserved: boolean;
  error?: string;
}

/**
 * 无条件落盘。`preserved` 看的是**模型原文**，不是文件是否被创建。
 */
export function persistReviewRaw(opts: {
  destPath: string;
  modelText: string;
  artifact: string;
  mkdir?: (dir: string) => void;
  writeFile?: (path: string, data: string) => void;
}): ReviewRawPersist {
  const bytes = Buffer.byteLength(opts.modelText, "utf8");
  const hasModel = opts.modelText.trim().length > 0;
  try {
    const mkdir = opts.mkdir ?? ((dir: string) => mkdirSync(dir, { recursive: true }));
    const write = opts.writeFile ?? ((p: string, d: string) => writeFileSync(p, d));
    mkdir(dirname(opts.destPath));
    write(opts.destPath, opts.artifact);
    return { path: opts.destPath, bytes, preserved: hasModel };
  } catch (e) {
    return {
      path: opts.destPath,
      bytes,
      preserved: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function parseKindLabel(kind: UnparseableKind): string {
  switch (kind) {
    case "empty":
      return "原文为空";
    case "missing-section":
      return "没有 `Full review comments:` 小节";
    case "unrecognised":
      return "有小节但 finding 认不出";
    case "incomplete":
      return "输出不完整（结束标记缺失）";
  }
}

/**
 * 报告契约 —— **所有引擎共用同一份**。
 *
 * 格式是契约：每个适配器负责**产出**它，而不是各带一个解析器各说各话。codex 的
 * `exec review` 天然是这个形状；claude / grok 由提示词要求它照这个形状输出。
 * 解析器因此只有一个（`parseReviewReport`）。
 */
/**
 * 一次性 nonce 的指令。引擎必须原样复制它作为最后一行。
 *
 * arc#6123:codex 在没发现问题时**整节不写**,而 `(none)` 是解析器认「干净」的唯一
 * 形状 —— 于是「有 finding → FAIL / 没 finding → BLOCKED」,**accept path 从来没有
 * 成立过**。原设计拒绝相信空白是对的(空白与被截断无法区分);nonce 把那个区分补上:
 * **nonce 在 = 这份输出完整**,于是「完整且零条」不再和「被截断」同色。
 */
export function reportContractWithNonce(nonce: string): string {
  return [
    REPORT_CONTRACT,
    "",
    `**最后一行**必须是这一串,单独成行、不加引号、前后不带别的字:${nonce}`,
    "它只证明这份输出没有被截断,**不**代表没有问题——所以:",
    "没发现问题时,**仍然必须**写出 `(none)` 那一行,再写这个结束标记。",
    "只写散文结论而不写 `(none)`,会被判为「没跑完」而不是「审过了、干净」——",
    "因为「审完了没问题」和「我没能审」在那种输出上无法区分。",
  ].join("\n");
}

export const REPORT_CONTRACT = [
  "输出格式（严格遵守，不要加别的小节）：",
  "先一段两三句的总结，然后一行 `Full review comments:`，然后每条 finding 一段：",
  "- [P1|P2|P3] <一句话标题> — <仓库相对路径>:<行号或行号区间>",
  "  <两三句说明：具体会怎么错，不是泛泛而谈>",
  "**没有任何问题时**，在 `Full review comments:` 之后只写一行 `(none)` —— 零条必须由",
  "这个哨兵证明，空白不算（空白与「被截断」无法区分）。",
].join("\n");

/**
 * 报告契约的 JSON 编码。给会兑现 `--output-schema` 的引擎（codex `exec`）。
 *
 * openai/codex#38545：`exec review` 接受该 flag 但忽略它，退出 0 并写出散文——
 * 那正是平凡 diff 上 #6187 被随机 BLOCKED 的形状。schema 必须走会强制兑现的
 * `codex exec`，不能靠模型在自由文本末尾自觉贴哨兵。
 *
 * 空 `findings` 就是结构化的 `(none)`。nonce 字段就是结构化的结束证明。
 * 两者都缺的散文，解析器仍然 unparseable（#6123 不许退回去）。
 *
 * OpenAI structured outputs 要求 strict：每个 object 都 `additionalProperties: false`，
 * `required` 列出全部键。
 */
export const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings", "nonce"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title", "file", "line", "body"],
        properties: {
          severity: { type: "string", enum: ["P1", "P2", "P3"] },
          title: { type: "string" },
          file: { type: "string" },
          line: { type: "string" },
          body: { type: "string" },
        },
      },
    },
    nonce: { type: "string" },
  },
} as const;

/**
 * 一个引擎怎么被**无头只读**地调起来。
 *
 * **这里只有契约，没有引擎表。** 引擎的身份（id / bin / fallbackBins）是消费仓库
 * 的事——arc 侧从 `providers/runtime/code-agents` 的 `STANDARD_DEFS` 派生，插件不再
 * 抄一份（那正是仓库 checklist 点名的「新写一个 provider 注册机制」）。
 *
 * 为什么 `EngineDef.buildArgs` 不能直接用：那是**长驻 / ACP** 那条路，参数是
 * `--always-approve` / `--approve-for-me` —— 只读的反面。一次性 review 是另一个面，
 * 由消费仓库在 `EngineDef` 之外补上。
 *
 * 解析器不在这里分引擎：报告格式是**共用契约**（`REPORT_CONTRACT`），每个适配器
 * 负责产出它。
 */
export interface ReviewerEngine {
  /** 可执行名。来自消费仓库的引擎注册表，不在插件里硬写。 */
  bin: string;
  fallbackBins?: string[];
  /** 不含 bin 的参数。必须是只读姿态。prompt 由调用方给——引擎不知道报告长什么样。 */
  args(opts: {
    prompt: string;
    base: string;
    title?: string;
    outFile?: string;
    /** 报告契约的 JSON Schema 文件。引擎不支持则忽略。 */
    schemaFile?: string;
  }): string[];
  /** `file` = 写进 `outFile`；`stdout` = 直接打到标准输出。 */
  outputMode: "file" | "stdout";
}

export type ReviewerTable = Record<string, ReviewerEngine>;

let TABLE: ReviewerTable = {};

/** 消费仓库注入自己的引擎表。插件自带的是**空表**，不是一份 arc 的副本。 */
export function setReviewerEngines(t: ReviewerTable): void {
  TABLE = t;
}

export function reviewerEngines(): ReviewerTable {
  return TABLE;
}

/**
 * 认不出的引擎**抛错**；表是空的也抛错。
 *
 * 「不写死某个引擎」的正确实现是注册表 + 注入，不是「认不出就退回默认」——后者会让一个
 * 打错字的引擎名静静变成默认引擎自审自己，而那正是本模块要禁止的那件事。
 */
export function assertReviewerEngine(engine: string): ReviewerEngine {
  const ids = Object.keys(TABLE);
  if (ids.length === 0) {
    throw new Error(
      "no reviewer engines are registered — the consuming repo must call setReviewerEngines() (see repo-profile `reviewer_engines`)",
    );
  }
  const found = TABLE[engine];
  if (!found) {
    throw new Error(`reviewer engine "${engine}" is not registered (have: ${ids.join(", ")})`);
  }
  return found;
}

/**
 * 在 `bin` 与 `fallbackBins` 里挑第一个**真的能找到**的可执行文件。
 *
 * `which` 由调用方注入，默认用 `Bun.which` —— 这个模块是插件的契约层，
 * 不该自己去碰宿主，注入也让下面的测试不必依赖机器上装了什么。
 *
 * **一个都找不到时返回 `bin`**，让 spawn 自己以 ENOENT 失败并把那个名字说出来 ——
 * 比在这里抛一个「没有可用引擎」更容易查（错误信息里带着它试过的名字）。
 */
export function resolveReviewerBin(
  e: ReviewerEngine,
  which: (cmd: string) => string | null = (cmd) =>
    (globalThis as { Bun?: { which(c: string): string | null } }).Bun?.which(cmd) ?? null,
): string {
  for (const cand of [e.bin, ...(e.fallbackBins ?? [])]) {
    if (which(cand)) return cand;
  }
  return e.bin;
}

export function reviewerArgv(
  engine: string,
  opts: { prompt: string; base: string; title?: string; outFile?: string; schemaFile?: string },
  which?: (cmd: string) => string | null,
): string[] {
  const e = assertReviewerEngine(engine);
  /**
   * #5697 第 2 轮 review 的 P2 —— 原来这里是 `[e.bin, ...]`，**`fallbackBins`
   * 一次都没有被消费过**：类型里声明了、投影表填了、文档写了，而命令构造直接用
   * `e.bin`。
   *
   * 后果：只装了受支持别名（`claude-code` / `grok-build`）的部署，在普通 engine
   * probe 里是「可用」的，到了 local-review 却 ENOENT 并**永久 BLOCKED** ——
   * 「这个引擎没装」与「这个引擎装的是别名」同色。
   *
   * 这是「声明即配套」的反面：声明了一个能力却没兑现它。
   */
  return [resolveReviewerBin(e, which), ...e.args(opts)];
}

export type CrossEngineReason = "cross-engine" | "same-engine" | "unknown";

/**
 * `unknown` 是**缺席的名字**，不是一个引擎。
 *
 * `agent-identity.sh` 在既没有 `--engine`、也没有 `$ARC_AGENT_ENGINE`、自检也失败时，
 * 输出的是字面量 `engine:unknown`。把它当引擎名比，`codex` vs `unknown` 就是
 * 「不同引擎」——**codex 审 codex 的 PR 直接拿到 PASS**，而且不需要任何标志。
 */
const ABSENT_ENGINE = new Set(["", "unknown", "none", "n/a"]);

function normalizeEngine(v: string | undefined): string {
  const t = (v ?? "").trim().toLowerCase();
  return ABSENT_ENGINE.has(t) ? "" : t;
}

/**
 * 把身份行 / run 记录里的 coder 引擎收成集合（arc#6184）。
 *
 * `engine:grok-build+claude` 与多个 `engine:` 字段是同一种意思。`/<model>` 只属于
 * 单引擎身份，混写时丢掉 —— 独立性比的是 kind。
 */
export function parseEngineSet(v: string | readonly string[] | undefined): string[] {
  if (v === undefined) return [];
  const parts = typeof v === "string" ? [v] : [...v];
  const out: string[] = [];
  for (const item of parts) {
    if (!item) continue;
    for (const token of item.split("+")) {
      const kind = normalizeEngine(token.split("/")[0]);
      if (kind && !out.includes(kind)) out.push(kind);
    }
  }
  return out;
}

/** 追加而不是覆盖。改成 `return n ? [n] : [...prior]` 就是 #6184 的假 PASS。 */
export function unionCoderEngines(prior: readonly string[], next: string): string[] {
  const n = normalizeEngine(next.split("/")[0]);
  if (!n) return [...prior];
  return prior.includes(n) ? [...prior] : [...prior, n];
}

/**
 * 往已有 PR 正文的身份行追加一个 coder 引擎。没有身份行就原样返回——不发明一行。
 */
export function appendCoderEngine(prBody: string, nextEngine: string): string {
  const prior = parseEngineSet(agentAuthored(prBody).coderEngine);
  const engines = unionCoderEngines(prior, nextEngine);
  const joined = engines.join("+");
  if (!joined) return prBody;
  const identity = /^>\s*🤖\s*AI Agent\b.*$/m.exec(prBody);
  if (!identity) return prBody;
  const stripped = identity[0].replace(/(?:\s*·\s*)?engine:[^\s·]+/g, "");
  return prBody.replace(identity[0], `${stripped} · engine:${joined}`);
}

function registeredIds(table: ReviewerTable = TABLE): ReadonlySet<string> {
  return new Set(
    Object.keys(table)
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * 对照注册表把引擎名收成 canonical id。未注册、缺席、表是空的 → `""`。
 *
 * 两个任意字符串的不等不能当成跨引擎（#5697 f1kdxa2v）：`codxe` vs `codex`
 * 在原始比较里是 cross-engine PASS，而 `codxe` 根本不是一个引擎。
 */
export function canonicalizeEngine(v: string | undefined, table: ReviewerTable = TABLE): string {
  const t = normalizeEngine(v);
  if (!t) return "";
  const ids = registeredIds(table);
  if (ids.size === 0) return "";
  return ids.has(t) ? t : "";
}

/**
 * 硬不变量。**「不知道」不等于「独立」**——缺 subjectEngine 时不得放行（#5352：
 * absence is unknown independence, never inferred as cross-engine）。
 *
 * coder 是集合（arc#6184）：`reviewer ∈ coderEngines` → same-engine；
 * reviewer 已注册且不在集合里 → cross-engine。未注册 → `unknown`，不是 cross-engine。
 */
export function crossEngineVerdict(
  reviewerEngine: string | undefined,
  subjectEngine: string | readonly string[] | undefined,
): { ok: boolean; reason: CrossEngineReason } {
  const a = canonicalizeEngine(reviewerEngine);
  const subjects = parseEngineSet(subjectEngine)
    .map((s) => canonicalizeEngine(s))
    .filter(Boolean);
  if (!a || subjects.length === 0) return { ok: false, reason: "unknown" };
  return subjects.includes(a)
    ? { ok: false, reason: "same-engine" }
    : { ok: true, reason: "cross-engine" };
}

/**
 * 省略 `--engine` 时挑一个**已注册且与 coder 不同**的 reviewer（#5697 f1gtawqv）。
 *
 * 写死 `codex` 会让每一个 `engine:codex` 的 PR 在默认命令下 same-engine BLOCKED。
 * coder 未注册 / 表里没有第二个引擎 → `undefined`（调用方 fail-closed，不猜）。
 */
export function pickDefaultReviewer(
  coderEngine: string | readonly string[] | undefined,
  table: ReviewerTable = TABLE,
): string | undefined {
  const coders = parseEngineSet(coderEngine)
    .map((s) => canonicalizeEngine(s, table))
    .filter(Boolean);
  if (coders.length === 0) return undefined;
  const coderSet = new Set(coders);
  for (const id of Object.keys(table)) {
    const canonical = canonicalizeEngine(id, table);
    if (canonical && !coderSet.has(canonical)) return canonical;
  }
  return undefined;
}

/** merge-gate 印在失败提示里的重跑命令。必须带 `--engine`，否则默认又撞上 coder。 */
export function localReviewRerunHint(
  pr: string,
  coderEngine: string | readonly string[] | undefined,
  table: ReviewerTable = TABLE,
): string {
  const picked = pickDefaultReviewer(coderEngine, table);
  const engineArg = picked ? ` --engine ${picked}` : " --engine <other-registered-engine>";
  return `bun .claude/plugins/agentloop/scripts/local-review.ts --pr ${pr}${engineArg} --post`;
}

/** `## 本地 review · <engine> 审 <subject>` —— renderReviewComment 写的 heading。 */
const REVIEW_HEADING_RE = /^## 本地 review · (\S+) 审 /m;

export function parseReviewerEngineFromComment(body: string): string | undefined {
  const m = REVIEW_HEADING_RE.exec(body);
  const raw = m?.[1];
  const canonical = canonicalizeEngine(raw);
  return canonical || undefined;
}

export interface LocalReviewAttestation {
  body: string;
  /** GitHub-attested comment author (`user.login`). Not taken from the body. */
  author: string | undefined;
  /** GitHub-attested PR author (`user.login`). */
  prAuthor: string | undefined;
  coderEngine: string | undefined;
  /**
   * False when `coderEngine` is only the author's commit trailer. SHA-binding
   * stops a later edit; it does not prove someone else wrote the commit.
   * Omitted means the caller did not say, and a cross-engine heading still stands.
   */
  coderAttested?: boolean;
  prHead: string;
}

/**
 * Gate 6 在 `requireStickyGate` 之上的独立检查（#5697 f1pxdxbw / 独立 review B）。
 *
 * `requireStickyGate` 只看 marker 的 sha=/result=。一行
 * `<!-- local-review sha=HEAD result=PASS -->` 就能过 —— 所以这道门**不信任
 * `result=` 作为独立性证明**，按 heading 引擎 + 注册表重算。
 *
 * 独立衬底是 **引擎类型**（#5688：同一 worker、不同类型的 agent），不是 GitHub
 * 账号。工厂的默认形态是同一 `gh` token 调不同引擎；用 `user.login ≠ PR author`
 * 当独立性，会让每一条作者机器上的跨引擎 review 恒 BLOCKED。
 *
 * `author` / `prAuthor` 只作审计字段，缺席或相同都不阻断。
 *
 * NA 也不收：docs/native 豁免不是跨引擎证据。
 */
export function attestLocalReview(i: LocalReviewAttestation): GatePass | GateFail {
  const markerLine = i.body.split("\n")[0] ?? "";
  const sha = /sha=([0-9a-f]+)/.exec(markerLine)?.[1];
  const result = /result=([A-Z]+)/.exec(markerLine)?.[1];
  if (!sha) return { ok: false, reason: "cross-engine review comment has no sha= in its marker" };
  if (sha !== i.prHead) {
    return {
      ok: false,
      reason: `cross-engine review sha mismatch — comment has ${sha.slice(0, 9)} but PR HEAD is ${i.prHead.slice(0, 9)}`,
    };
  }
  if (result !== "PASS") {
    return {
      ok: false,
      reason: `cross-engine review result is ${result ?? "(missing)"} — must be PASS (NA is not evidence)`,
    };
  }
  const reviewer = parseReviewerEngineFromComment(i.body);
  if (!reviewer) {
    return {
      ok: false,
      reason: "cross-engine review comment does not name a registered reviewer engine",
    };
  }
  const verdict = crossEngineVerdict(reviewer, i.coderEngine);
  if (!verdict.ok) {
    return {
      ok: false,
      reason: `cross-engine review independence is ${verdict.reason} (reviewer=${reviewer}, coder=${i.coderEngine ?? "(undeclared)"})`,
    };
  }
  if (i.coderAttested === false) {
    return {
      ok: false,
      reason:
        `cross-engine review independence is unattested (reviewer=${reviewer}, coder=${i.coderEngine ?? "(undeclared)"})` +
        " — a commit trailer is the author's own claim",
    };
  }
  // 正文里的「判决 **…**」是 producer 按 heading 算的。只改 marker 的
  // `result=PASS`、却留下 `判决 **BLOCKED**`，必须被抓到。
  const declared = /判决 \*\*(PASS|FAIL|BLOCKED)\*\*/.exec(i.body)?.[1];
  if (declared && declared !== "PASS") {
    return {
      ok: false,
      reason: `cross-engine review marker says PASS but the comment body declares ${declared} — result= is not evidence of independence`,
    };
  }
  return { ok: true, sha, result: "PASS" };
}

type Runner = (cmd: string) => { code: number; out: string; ms: number };

const SHA40_RE = /^[0-9a-f]{40}$/;

export type ReviewHeadGate =
  | { ok: true; sha: string; prHead: string }
  | { ok: false; reason: string };

/**
 * `--pr N` 的审查范围是 **PR N 的 head**，不是调用方 cwd 碰巧在的 HEAD。
 *
 * 未强制这条时：从别的 worktree 调用会认真 review 另一份 diff，输出带 nonce、
 * 格式合法，于是「审过这个 PR」与「审的是别的东西」同色（arc#6195）。
 * nonce 证明输出没被截断，不证明输入是对的。
 *
 * **必须在 spawn 引擎之前调用。** `--post` 不是唯一入口——不带 `--post` 时
 * 操作者同样会拿到一份看起来完全合法的错 review。读不到 PR head 也停：
 * 「读不到」不是「就是当前 HEAD」。
 */
export function assertCwdIsPrHead(opts: {
  pr: string;
  localSha: string;
  cwd: string;
  runner: Runner;
}): ReviewHeadGate {
  const local = opts.localSha.trim();
  if (!SHA40_RE.test(local)) {
    return {
      ok: false,
      reason:
        `✗ 本地 HEAD 不是 40 位 SHA（${local || "(empty)"}）—— cwd 必须是被审的工作树\n` +
        `  cwd ${opts.cwd}`,
    };
  }
  const fetched = opts.runner(
    `gh api "repos/{owner}/{repo}/pulls/${opts.pr}" --jq .head.sha 2>/dev/null`,
  );
  const prHead = fetched.code === 0 ? fetched.out.trim() : "";
  if (!SHA40_RE.test(prHead)) {
    return {
      ok: false,
      reason:
        `✗ 取不到 PR #${opts.pr} 的 head sha（gh 退出 ${fetched.code}）—— 停。\n` +
        `  「读不到」不是「就是当前 HEAD」：猜错了会审错范围，而判决看起来一切正常。\n` +
        `  本地 HEAD  ${local}\n` +
        `  cwd        ${opts.cwd}`,
    };
  }
  if (prHead !== local) {
    return {
      ok: false,
      reason:
        `✗ 本地 HEAD 不是 PR #${opts.pr} 的 head —— 拒绝审这份 diff。\n` +
        `  本地 HEAD  ${local}\n` +
        `  PR head    ${prHead}\n` +
        `  cwd        ${opts.cwd}\n` +
        `  请在该 PR 的 worktree 里运行（那棵树的 HEAD 必须是 PR head）。`,
    };
  }
  return { ok: true, sha: local, prHead };
}

/**
 * Gate 6 的完整 sticky 检查：sha/result=PASS（不收 NA）+ heading 引擎已注册
 * 且与 coder 跨引擎。GitHub login 只作审计，不是独立性证明。
 */
/**
 * 闸失败时**该不该重跑 reviewer** —— 从既有 sticky 的实际状态推出来，不是套话。
 *
 * 这道门以前对每一种失败都打印同一句 `Re-run: <命令>`，包括这两种它**帮不上忙**的：
 *
 * - `result=FAIL` 是 reviewer 报了真实 finding。**重跑不会改变它**（代码没变，
 *   下一轮读的还是同一份 diff）。而提示字面上就是「再跑一次」，于是 agent 照做。
 * - `round >= ROUND_CAP` 且未收敛，语义是 `escalate` —— 交给人。再跑一轮只会把
 *   round 推到 4、5、6，判决**恒为 BLOCKED**（`reviewResultForRound`）。
 *
 * 「该重跑」（sha 陈旧、没有 sticky）与「重跑没有用」在同一句提示上同色，是
 * arc#6255 那一小时三轮的直接原因。返回 `undefined` 表示这次失败确实该重跑。
 *
 * ## 触顶那一条必须同时看 `result`
 *
 * `round >= ROUND_CAP` **不等于**「未收敛」。第 3 轮完全可以是 `PASS`（收敛了），
 * 之后有人推了一个新 commit —— 这时闸失败的原因是 **sha 陈旧**，正确动作恰恰是
 * **对新 commit 重跑**。只看轮次就会打印「到顶了，停止重跑，交给人」，把一次正常的
 * 增量复审误导成升级。这与本函数要根除的病是同一个：**在一个还没确定它走没走到的
 * 分支上给结论**。所以触顶提示只在判决**不是** PASS 时给。
 */
export function rerunDiscipline(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const result = /^<!-- local-review [^>]*result=([A-Z]+)/m.exec(body)?.[1];
  const round = parseReviewState(body)?.round;
  const lines: string[] = [];
  if (result === "FAIL") {
    lines.push(
      "⚠ 上一份 review 的判决是 FAIL —— 那是 reviewer 报了真实 finding。**重跑不会改变它**：" +
        "先修掉 findings（或在 PR 上回复 REJECT 并说明理由），改完再跑。",
    );
  }
  // `result !== "PASS"` 而不是 `result === "BLOCKED"`：读不到 result（marker 漂了）
  // 时也不该假定它收敛过 —— 那是「不知道」，按未收敛处理才是 fail-closed 的一侧。
  if (typeof round === "number" && round >= ROUND_CAP && result !== "PASS") {
    lines.push(
      `⚠ 已经跑到第 ${round} 轮（上限 ${ROUND_CAP}）且未收敛 —— 这是 escalate，不是「再跑一轮」。` +
        "停止重跑，把账本交给人：到顶仍未收敛时判决恒为 BLOCKED，第 4 轮不会变绿。",
    );
  }
  return lines.length ? lines.join("\n") : undefined;
}

export function requireLocalReviewSticky(
  pr: string,
  prHead: string,
  rerunHint: string,
  runner: Runner,
  ctx: { prAuthor: string | undefined; coderEngine: string | undefined; coderAttested?: boolean },
): GatePass | GateFail {
  let captured: { body?: string; user?: { login?: string } | null } | undefined;
  const wrap: Runner = (cmd) => {
    const r = runner(cmd);
    if (r.code === 0 && r.out.trim()) {
      try {
        const parsed = JSON.parse(stripAnsi(r.out)) as {
          body?: string;
          user?: { login?: string } | null;
        };
        if (parsed && typeof parsed.body === "string") captured = parsed;
      } catch {
        /* not comment JSON */
      }
    }
    return r;
  };
  const gate = requireStickyGate(
    pr,
    prHead,
    LOCAL_REVIEW_PREFIX,
    "cross-engine review",
    rerunHint,
    wrap,
    { accept: ["PASS"] },
  );
  if (!gate.ok) {
    const discipline = rerunDiscipline(captured?.body);
    return discipline ? { ...gate, detail: `${gate.detail ?? ""}\n${discipline}`.trim() } : gate;
  }
  return attestLocalReview({
    body: captured?.body ?? "",
    author: captured?.user?.login,
    prAuthor: ctx.prAuthor,
    coderEngine: ctx.coderEngine,
    coderAttested: ctx.coderAttested,
    prHead,
  });
}

/* ===== codex 产物解析 ===== */

/**
 * 一条 finding。`path:line` 允许被 markdown 的行内代码包裹(arc#6153)。
 *
 * 为什么容忍反引号:reviewer 的输出**就是 markdown**,把路径写成 `` `a/b.ts:12` ``
 * 是那个语境里最自然的写法,而契约的示例行本身也印在 markdown 上。实测
 * `grok-build` 审 PR #6002 时输出了一条**完全符合契约**的 P3,只因行尾多一个反引号
 * 就整条匹配不上;小节里没有别的可认的东西,于是判 unparseable —— **「reviewer 报了
 * 问题」被渲染成了「reviewer 输出读不懂」**,而这两者在 `result=BLOCKED` 上同色。
 *
 * 容忍的边界与 {@link CLEAN_SENTINEL} 同一条:只放过**不改变「这是一条 finding」**
 * 的包裹。缺 `— path:line` 整段、或根本不是 `- [Pn]` 开头的行,照旧认不出 ——
 * 那条 reject 臂是本次放宽的正控,没有它,一个「什么都算一条」的正则会同样让
 * accept 臂变绿。
 *
 * arc#6199 —— 上一次放宽得**不够宽**。它接受 `` `path:line` ``(反引号包住整个位置),
 * 却接不住 `` `path`:line ``(反引号在冒号**之前**就闭合,只包路径)。后者同样是
 * markdown 里最自然的写法之一——路径是代码,行号不是——而 `[^\s`]+?` 这个字符类跨不过
 * 反引号,于是 `` ` `` 之后遇到的不是 `:`,整条失配。实盘代价:PR #6112 上一份 2419 bytes、
 * nonce 独占末行、含**两条经人工核实为真的 P2** 的报告,被渲染成 `0 条 · 判决 BLOCKED`。
 * 所以路径两侧各允许一个可选反引号,而不是只允许包住整体的那一对。
 */
const FINDING_RE = /^-\s*\[(P\d)\]\s*(.+?)\s+—\s+`?([^\s`]+?)`?:(\d+(?:-\d+)?)`?(\s.*)?$/;
const SECTION = "Full review comments:";

/** 单条 finding 正文的上限。超出要**说出来**，不能悄悄截。 */
const BODY_CAP = 1200;

/** GitHub 单条评论的硬上限。 */
export const COMMENT_CAP = 65_536;

/**
 * **「零条 finding」与「解析器没看懂」必须不同色。**
 *
 * 一个看不懂输出的解析器返回 `[]`，与一次干净的 review 完全同色——而干净是那个会
 * 放行合并的答案。所以不认识的形状一律 `unparseable`，由调用方 fail-closed，
 * 绝不降级成「没发现问题」。
 */
/** 兼容旧名。契约是共用的，名字里不该带某一个引擎。 */
export const parseCodexReview = parseReviewReport;

/**
 * 明确的「这一轮没有 finding」——**只有契约规定的那一个形状**允许零条通过。
 *
 * `REPORT_CONTRACT` 写的是「只写一行 `(none)`」，而这条正则原来还认
 * `n/a`、`—`、以及**一个裸 `-`**。实测（#5697 第 2 轮 review 的 P1）：
 *
 *     "(none)"   → ok=true findings=0     ← 契约规定的
 *     "-"        → ok=true findings=0     ← **一个连字符就 PASS**
 *     "—"        → ok=true findings=0
 *     "N/A"      → ok=true findings=0
 *
 * reviewer 输出被截断、吐了个占位符、或者根本没答完 —— 只要末尾落在一个连字符上，
 * 闸就放行合并。**「审完了没问题」与「没审完」于是同色**，而这个文件上面几行刚写着
 * 「不认识的形状一律 `unparseable`，绝不降级成『没发现问题』」。契约与实现分叉了，
 * 按契约收紧。
 *
 * 仍然容忍的只有大小写、外层括号、结尾句点和首尾空白 —— 那些不改变「这是一个
 * 明确的完成标记」这件事。
 */
const CLEAN_SENTINEL = /^\(?\s*none\s*\)?\.?$/i;

type BodyResult =
  | { ok: true; findings: ReviewFinding[] }
  | { ok: false; kind: Exclude<UnparseableKind, "incomplete">; findings: ReviewFinding[] };

function parseFindingLine(raw: string, opts: { repoRoot?: string }): ReviewFinding | undefined {
  const m = FINDING_RE.exec(raw.trimEnd());
  const [, severity, title, file, line, trailing] = m ?? [];
  if (!severity || !title || !file || !line) return undefined;
  return {
    severity,
    title: title.trim(),
    file: repoRelative(file, opts.repoRoot),
    line,
    body: (trailing ?? "").trim(),
  };
}

function parseReviewBody(
  text: string,
  opts: { repoRoot?: string },
  complete: boolean | undefined,
): BodyResult {
  if (!text.trim()) return { ok: false, kind: "empty", findings: [] };
  const idx = text.indexOf(SECTION);
  if (idx < 0) {
    // 没有小节头。**不许因为「找不到 finding」就判干净**。
    const body = text.split("\n");
    const orphan = body.filter((l) => /\[P\d\]/.test(l));
    const salvaged: ReviewFinding[] = [];
    let cur: ReviewFinding | undefined;
    let unrecognised = false;
    for (const raw of body) {
      const hit = parseFindingLine(raw, opts);
      if (hit) {
        cur = hit;
        salvaged.push(cur);
        continue;
      }
      if (/\[P\d\]/.test(raw)) {
        unrecognised = true;
        break;
      }
      const t = raw.trim();
      if (cur && t && !t.startsWith("-") && !t.startsWith("*")) {
        cur.body = `${cur.body} ${t}`.trim().slice(0, BODY_CAP);
      }
    }
    if (complete) {
      if (orphan.length === 0) {
        const sawSentinel = body.some((l) => CLEAN_SENTINEL.test(l.trim()));
        return sawSentinel
          ? { ok: true, findings: [] }
          : { ok: false, kind: "missing-section", findings: [] };
      }
      if (unrecognised) return { ok: false, kind: "unrecognised", findings: salvaged };
      return { ok: true, findings: salvaged };
    }
    // 不完整 / 没传 nonce：ok 永远是 false，但认得出的 finding 要带走（#6165）。
    return {
      ok: false,
      kind: unrecognised ? "unrecognised" : "missing-section",
      findings: salvaged,
    };
  }
  const findings: ReviewFinding[] = [];
  const lines = text.slice(idx + SECTION.length).split("\n");
  let current: ReviewFinding | undefined;
  let unclaimed = 0;
  let sawCleanSentinel = false;
  for (const raw of lines) {
    const hit = parseFindingLine(raw, opts);
    if (hit) {
      current = hit;
      findings.push(current);
      continue;
    }
    const line = raw.trim();
    if (!line) continue;
    if (current && !line.startsWith("-") && !line.startsWith("*")) {
      if (current.body.length < BODY_CAP) {
        current.body = `${current.body} ${line}`.trim();
        if (current.body.length >= BODY_CAP) {
          current.body = `${current.body.slice(0, BODY_CAP)}… （正文过长，已截断）`;
        }
      }
      continue;
    }
    if (CLEAN_SENTINEL.test(line)) sawCleanSentinel = true;
    else unclaimed++;
  }
  if (findings.length === 0 && (!sawCleanSentinel || unclaimed > 0)) {
    return { ok: false, kind: "unrecognised", findings: [] };
  }
  return { ok: true, findings };
}

function parseWholeJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const fence = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  const body = (fence ? fence[1] : trimmed).trim();
  if (!body.startsWith("{")) return undefined;
  try {
    const v: unknown = JSON.parse(body);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    return undefined;
  } catch {
    return undefined;
  }
}

function structuredFinding(item: unknown, repoRoot?: string): ReviewFinding | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const rec = item as Record<string, unknown>;
  const { severity, title, file, line, body } = rec;
  if (typeof severity !== "string" || !/^P\d$/.test(severity)) return undefined;
  if (typeof title !== "string" || !title.trim()) return undefined;
  if (typeof file !== "string" || !file.trim()) return undefined;
  if (typeof line !== "string") return undefined;
  if (typeof body !== "string") return undefined;
  return {
    severity,
    title: title.trim(),
    file: repoRelative(file, repoRoot),
    ...(line.trim() ? { line: line.trim() } : {}),
    body: body.trim().slice(0, BODY_CAP),
  };
}

/**
 * 整份输出是报告契约的 JSON 编码时走这里。不是 JSON、或没有 `findings` 数组
 * → `undefined`，落到 markdown 解析器（grok-build / claude 的路径一字不改）。
 *
 * 一旦认成结构化，缺 nonce / 缺字段 / 一条 finding 形状不对都是 unparseable，
 * **不许**再当散文去「猜干净」。空 `findings` 才是结构化的 `(none)`。
 * 失败结果带 kind / 已捞回的 findings（#6165），不把结构化失败压成「0 条」。
 */
function tryParseStructuredReview(
  stdout: string,
  opts: { repoRoot?: string; nonce?: string },
): ParseResult | undefined {
  const obj = parseWholeJsonObject(stdout);
  if (!obj || !("findings" in obj)) return undefined;
  if (!Array.isArray(obj.findings)) return unparseable("unrecognised", stdout);
  const findings: ReviewFinding[] = [];
  for (const item of obj.findings) {
    const f = structuredFinding(item, opts.repoRoot);
    if (!f) return unparseable("unrecognised", stdout, findings);
    findings.push(f);
  }
  if (opts.nonce) {
    if (typeof obj.nonce !== "string" || obj.nonce !== opts.nonce) {
      return unparseable("incomplete", stdout, findings);
    }
  }
  return { ok: true, findings };
}

export function parseReviewReport(
  stdout: string,
  opts: { repoRoot?: string; nonce?: string } = {},
): ParseResult {
  // arc#6187：JSON 编码的 nonce 在字段里，不在最后一行。必须先于「末行 nonce」
  // 那条 markdown 判据，否则一份合法的结构化干净报告会被 `}` 挡成 unparseable。
  const structured = tryParseStructuredReview(stdout, opts);
  if (structured !== undefined) return structured;
  // arc#6123。`nonce` 是**加法**:不传它,下面每一条判据的 **ok** 逐字节不变。
  //
  // 它只回答一个问题——**这份输出跑完了吗**。它**不**回答「有没有问题」。
  // 缺 nonce ⟹ unparseable（不能 PASS）。#6165 补的是另一侧：unparseable 时
  // 已经认得出的 finding 必须跟着失败结果走，不能在 nonce 检查处整份扔掉。
  //
  // nonce 必须**独占最后一个非空行**,不能只用 `includes`:实测只写一句
  // 「本轮的结束标记是 <nonce>,开始审查。」就会被判成完整(codex P2)。
  let complete: boolean | undefined;
  if (opts.nonce) {
    const nonEmpty = stdout.split("\n").filter((l) => l.trim() !== "");
    complete = nonEmpty.length > 0 && nonEmpty[nonEmpty.length - 1]?.trim() === opts.nonce;
  }
  if (!stdout.trim()) return unparseable("empty", stdout);
  // 验证在前、剥离在后 —— 顺序承重。留着它会落进下面的小节循环被计成 `unclaimed`,
  // 于是**严格照契约输出的干净报告反而被判 unparseable**(codex 上一轮的 P1(a))。
  // 只剥那一行,不是全文替换。
  const text = opts.nonce
    ? stdout
        .split("\n")
        .filter((l) => l.trim() !== opts.nonce)
        .join("\n")
    : stdout;
  const inner = parseReviewBody(text, opts, complete);
  if (opts.nonce && !complete) {
    return unparseable("incomplete", stdout, inner.findings);
  }
  if (inner.ok) return inner;
  return unparseable(inner.kind, stdout, inner.findings);
}

/**
 * codex 报的是绝对路径；贴到 PR 上要能点开，就得收成仓库相对路径。
 *
 * **仓库根由调用方给**，不靠在路径里找 `/arc/` 这种字面量——换个仓库、换个 checkout
 * 目录名就失灵（本地 codex 自审时报的 P2）。没给根时**保持原样**，不假装转换成功。
 */
function repoRelative(p: string, repoRoot?: string): string {
  if (!repoRoot) return p;
  const root = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  return p.startsWith(root) ? p.slice(root.length) : p;
}

export interface ReviewAttempt {
  stdout: string;
  failed: boolean;
}

/**
 * 把「解析一次；不行再按契约追问一次」收成可测的兑现路径。
 *
 * 进程失败（超时 / 非零）**不**重试——那是 reviewer 没跑完，与「跑完了但只出散文」
 * 不同色。散文不合规才追问一次；追问仍不合规 → 仍 unparseable，绝不读成干净。
 */
export function fulfillReviewContract(opts: {
  nonce: string;
  repoRoot?: string;
  first: ReviewAttempt;
  retry?: () => ReviewAttempt;
}): {
  parsed: ParseResult;
  stdout: string;
  failed: boolean;
  retried: boolean;
} {
  const parseRun = (run: ReviewAttempt) => ({
    parsed: parseReviewReport(run.stdout, { nonce: opts.nonce, repoRoot: opts.repoRoot }),
    stdout: run.stdout,
    failed: run.failed,
  });
  const first = parseRun(opts.first);
  // 进程失败仍带着解析结果（#6165 捞回），但不重试——超时/非零与散文不合规不同色。
  if (first.failed) return { ...first, retried: false };
  if (first.parsed.ok) return { ...first, retried: false };
  if (!opts.retry) return { ...first, retried: false };
  const second = parseRun(opts.retry());
  return { ...second, retried: true };
}

/** 第一次输出无法解析时的追问。点名缺的是契约，不是「再随便写一句没问题」。 */
export function contractRetryPrompt(nonce: string, originalPrompt?: string): string {
  const reminder = [
    "你上一轮的输出无法解析。这不是「没发现问题」，是没按契约输出。",
    "缺少 `Full review comments:`、`(none)` 哨兵、或结束标记。",
    "现在重新输出。只输出契约要求的格式，不要解释、不要道歉。",
    "",
    reportContractWithNonce(nonce),
  ].join("\n");
  return originalPrompt ? `${originalPrompt}\n\n—— 更正 ——\n${reminder}` : reminder;
}

/* ===== sticky comment —— 复用既有 gate 原语，不另造一套 ===== */

/**
 * 走仓库既有的 sticky-gate 约定（`makeMarker` / `requireStickyGate`）：marker 在第 1 行，
 * `<prefix> sha=… result=… -->`，而闸**只接受 {PASS, NA}**。
 *
 * 所以独立性不需要第五道门去单独解析——把它编进 `result` 就够了：
 * 同引擎 / 未知 / 解析失败一律 `BLOCKED`，既有的闸原样挡下，**第五道门零新逻辑**。
 * 这也正是 `BLOCKED` 被定义出来的意思：闸跑了，但要求的证据没能成立。
 */
export const LOCAL_REVIEW_PREFIX = "<!-- local-review";

export interface ReviewResultInput {
  reviewerEngine: string | undefined;
  subjectEngine: string | undefined;
  findings?: readonly ReviewFinding[];
  unparseable?: boolean;
}

/**
 * 判决只有一条可合并路径：**跨引擎 且 零 finding**。
 *
 * 独立性不成立时不是 FAIL 而是 BLOCKED——「没发现问题」在这种情况下不构成证据，
 * 与「审过了、干净」必须不同色。解析失败同理：看不懂输出绝不能走成「没问题」。
 */
export function reviewResult(i: ReviewResultInput): "PASS" | "FAIL" | "BLOCKED" {
  if (i.unparseable) return "BLOCKED";
  if (!crossEngineVerdict(i.reviewerEngine, i.subjectEngine).ok) return "BLOCKED";
  return (i.findings?.length ?? 0) > 0 ? "FAIL" : "PASS";
}

export interface ReviewCommentInput {
  round?: number;
  /** 第 N 轮的收敛结论。**marker 的 result 由它决定**，不另算一份。 */
  convergence?: Convergence;
  reviewerEngine: string;
  subjectEngine: string | undefined;
  sha: string;
  base: string;
  findings: ReviewFinding[];
  /** 上一轮的账本 —— 未了结的条目要被带进下一轮，否则它们会静默消失（#5697 P1）。 */
  prior?: readonly StateFinding[];
  unparseable?: boolean;
  /** parsed vs expected. Sticky 漏判时带上；缺席则标明不可用，绝不捏造 parsed:[]。 */
  parseDiag?: DispositionParseDiag;
  /** 解析失败的颜色。缺席时仍 BLOCKED，但不假装分过类。 */
  parseKind?: UnparseableKind;
  /** 原文摘录。有捞回的 finding 时可以不展示，但 0 条时必须让人看见模型说过什么。 */
  excerpt?: string;
  /** 原文落盘结果。preserved=false 与 preserved=true 必须不同色（#6172）。 */
  raw?: ReviewRawPersist;
}

export function renderReviewComment(i: ReviewCommentInput): string {
  const v = crossEngineVerdict(i.reviewerEngine, i.subjectEngine);
  // **marker 的 result 就是收敛判决**。曾经这里另算一份（只看跨引擎 + 零 finding），
  // 于是第 2 轮未收敛被写成 PASS —— 而第五道门只读 marker，直接放行。
  // 两个真相源里，闸读的那个必须是对的那个。
  const result = reviewResultForRound({ ...i, round: i.round ?? 1 }).result;
  const indep = v.ok
    ? "独立性 **" + v.reason + "**"
    : "独立性 **" + v.reason + "** —— 不满足 `reviewer.engine ∉ coderEngines`，不构成可合并证据";
  // 轮次账本紧跟 marker：JSON 藏在 HTML 注释里是**真相**，下面渲染出来的是派生的
  // （同 comment.ts 的 verify-history 先例——人改了正文不会污染序列）。
  const state =
    i.round === undefined
      ? ""
      : `${renderReviewState({ round: i.round, findings: nextRoundState(i.prior ?? [], i.convergence, i.findings) })}\n`;
  const unadjudicated = i.convergence?.unadjudicated ?? [];
  const parseDiagBlock =
    unadjudicated.length === 0
      ? ""
      : i.parseDiag
        ? `${formatDispositionParseDiag(i.parseDiag)}\n\n`
        : "_判定诊断不可用。_\n\n";
  const head =
    makeMarker(i.sha, result, LOCAL_REVIEW_PREFIX) +
    "\n" +
    state +
    "## 本地 review · " +
    i.reviewerEngine +
    " 审 " +
    (i.subjectEngine ?? "(未声明)") +
    "\n\n" +
    indep +
    " · base `" +
    i.base +
    "` · sha `" +
    i.sha.slice(0, 9) +
    "` · " +
    i.findings.length +
    " 条" +
    (i.round === undefined ? "" : " · 第 " + i.round + " 轮") +
    " · 判决 **" +
    result +
    "**\n\n" +
    parseDiagBlock;

  const one = (f: ReviewFinding) =>
    "- **[" +
    f.severity +
    "]** " +
    f.title +
    " — `" +
    f.file +
    ":" +
    (f.line ?? "") +
    "`\n  " +
    f.body;

  if (i.unparseable) {
    const kindLine = i.parseKind ? `**失败类型：** ${parseKindLabel(i.parseKind)}\n\n` : "";
    const rawLine = i.raw
      ? i.raw.preserved
        ? `**原文已保留** \`${i.raw.path}\`（${i.raw.bytes} 字节）—— 有内容可读，不要当成「没东西」扔掉。\n\n`
        : `**原文未保留**${i.raw.path ? `（尝试写入 \`${i.raw.path}\`）` : ""} —— 没接到模型输出，必须重跑；这与「说了但解析失败」不同色。\n\n`
      : "";
    const salvage =
      i.findings.length > 0
        ? `**捞回 ${i.findings.length} 条**（解析失败但仍认得出；判决仍是 BLOCKED，因为无法证明完整）：\n\n${i.findings.map(one).join("\n\n")}\n`
        : i.excerpt
          ? `原文摘录：\n\n\`\`\`\n${i.excerpt}\n\`\`\`\n`
          : "";
    return (
      head +
      "_reviewer 的输出无法解析 —— 这不是「没发现问题」，判 BLOCKED。_\n\n" +
      kindLine +
      rawLine +
      salvage
    );
  }
  if (!i.findings.length) return head + "_本轮无 finding。_\n";

  // 交付面有硬上限（GitHub 65536）。**截断必须说出来**，否则「只有 3 条」与
  // 「其余被悄悄丢了」同色；marker 在第一行，无论如何不能被切掉——它是闸唯一读的东西。
  const parts: string[] = [];
  let used = head.length;
  let dropped = 0;
  const NOTE = (n: number) =>
    "\n\n_… 另有 **" + n + " 条未展开**（评论长度上限 " + COMMENT_CAP + "）。_\n";
  for (const f of i.findings) {
    const piece = one(f);
    // 预留出脚注的位置，否则加满之后就塞不下「被截断」这句话了。
    if (used + piece.length + 2 + NOTE(i.findings.length).length > COMMENT_CAP) {
      dropped++;
      continue;
    }
    parts.push(piece);
    used += piece.length + 2;
  }
  return head + parts.join("\n\n") + (dropped ? NOTE(dropped) : "\n");
}

/* ===== 这道门管谁 ===== */

/**
 * 第五道门只对 **agent 写的 PR** 生效 —— 人写的 PR 没有「coder 引擎」这回事。
 *
 * 判据是 agentloop 自己的身份行（`scripts/agent-identity.sh` 产出，正文里的
 * `> 🤖 AI Agent …`），不是正文里恰好出现的 `engine:` 字样。
 *
 * **有身份行但没声明引擎，仍然要求**：放行会让「去掉 engine 字段」成为绕过这道门的
 * 办法。认不出 coder 引擎不是放行的理由——判决本来就由 reviewer 自己编进 `result`。
 */
export function agentAuthored(prBody: string): {
  required: boolean;
  coderEngine?: string;
  coderEngines?: string[];
} {
  const identity = /^>\s*🤖\s*AI Agent\b.*$/m.exec(prBody ?? "");
  if (!identity) return { required: false };
  const tokens = [...identity[0].matchAll(/\bengine:([A-Za-z0-9._+-]+)/g)].map((m) => m[1] ?? "");
  const engines = parseEngineSet(tokens);
  // engine:unknown 与「没有 engine 字段」同义 —— 都不是一个可以拿来比对的引擎名。
  return {
    required: true,
    ...(engines.length ? { coderEngine: engines.join("+"), coderEngines: engines } : {}),
  };
}

/**
 * subjectEngine 只能来自 **PR 自己记录的身份行**。
 *
 * 曾经允许 `--subject-engine` 直接覆盖 —— 那是闸自己的绕过口：一个 codex 作者用
 * codex reviewer 加 `--subject-engine claude` 就能造出一个 PASS marker，而门只看
 * `result=`。本地跨引擎 review 审这条改动时报的 P1。
 *
 * 现在覆盖只能**确认**、不能**改写**：与记录一致才放行，矛盾就拒绝。拿不到 PR 正文
 * 或正文没记录引擎时，覆盖一律不算数——无从核对的声明不是证据。
 *
 * ⚠️ **这条今天的强度是「约定」，不是「强制」。** 「记录」是 PR 正文，而开这个 PR 的
 * 同一个 agent 一条 `gh pr edit --body` 就能改写它（或者整段删掉身份行，让这道门
 * 直接不适用）。要真的强制，coder 引擎必须来自**它改不了的东西**——PR 首个 commit 的
 * 身份、或工厂侧的 run 记录。见 #5700。**不要把这段注释读成它已经做到了。**
 */
export function resolveSubjectEngine(
  prBody: string | undefined,
  override: string | undefined,
): { ok: true; engine: string } | { ok: false; reason: string } {
  const recorded = prBody === undefined ? undefined : agentAuthored(prBody).coderEngine;
  const recordedSet = parseEngineSet(recorded);
  if (recordedSet.length === 0) {
    return {
      ok: false,
      reason: "PR 没有记录 coder 引擎（身份行缺失或没有 engine: 字段），无从核对 —— 覆盖值不算数",
    };
  }
  if (override) {
    const o = normalizeEngine(override.split("/")[0]);
    if (!o || !recordedSet.includes(o)) {
      return {
        ok: false,
        reason: `--subject-engine ${override} 与 PR 记录的 ${recordedSet.join("+")} 矛盾`,
      };
    }
  }
  // 覆盖只能确认集合里有这一员，不能把混合作者塌成单值（arc#6184）。
  return { ok: true, engine: recordedSet.join("+") };
}

/* ===== 轮次与收敛 ===== */

/**
 * **不限轮次的 reviewer 会漂移，不会收敛。**
 *
 * 实测：同一条 PR 上 4 → 2 → 3、2 → 7 → 4。每一条都是真的，但**没有一轮是在回答
 * 上一轮**——reviewer 每次用全新的眼睛重扫，没有记忆也没有目标函数。
 *
 * 所以每一轮都带一个目标：第 1 轮广撒网；第 N 轮**主目标是逐条判定上一轮**，新问题
 * 只报 P1，其余记为 deferred。收敛 = 上一轮每条都 fixed 且无新 P1。
 *
 * **静默不算收敛**（`unadjudicated`）：漏判任何一条都判未收敛。否则 reviewer 可以靠
 * 「这轮没话说」假装收敛——那就是「审完了没事」与「它根本没看」又一次同色。
 */
export const ROUND_CAP = 3;

export type Disposition = "fixed" | "open" | "regressed";

export interface IdentifiedFinding extends ReviewFinding {
  id: string;
}

/**
 * 账本里**不存 finding 正文**：下一轮只需要「引用得到上一轮每一条」，而正文是最大的
 * 那一块。存了它，state 自己就能把评论撑过 65536（实测 149KB，交付直接 422）。
 */
export type StateFinding = Omit<IdentifiedFinding, "body">;

export interface ReviewState {
  round: number;
  findings: StateFinding[];
}

/** 落账用：去掉正文，只留下一轮引用得到的字段。 */
export function toStateFindings(findings: readonly ReviewFinding[]): StateFinding[] {
  return withIds(findings).map(({ body: _body, ...rest }) => rest);
}

export const STATE_MARKER = "<!-- local-review-state";

/** 稳定短 id：同一条 finding 跨轮次要能被引用。 */
export function findingId(f: ReviewFinding): string {
  const key = `${f.severity}|${f.file}|${f.line ?? ""}|${f.title}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `f${(h >>> 0).toString(36)}`;
}

export function withIds(findings: readonly ReviewFinding[]): IdentifiedFinding[] {
  return findings.map((f) => ({ ...f, id: (f as IdentifiedFinding).id ?? findingId(f) }));
}

/**
 * 状态藏在 HTML 注释里的 JSON 是**真相**，正文里渲染出来的是派生的。
 * 与 `comment.ts` 的 `verify-history` 同一个先例：人改了正文不会污染序列。
 */
export function renderReviewState(s: ReviewState): string {
  return `${STATE_MARKER} ${JSON.stringify(s)} -->`;
}

export function parseReviewState(body: string): ReviewState | undefined {
  const i = body.indexOf(STATE_MARKER);
  if (i < 0) return undefined;
  const end = body.indexOf("-->", i);
  if (end < 0) return undefined;
  try {
    const parsed = JSON.parse(body.slice(i + STATE_MARKER.length, end).trim()) as ReviewState;
    if (!Number.isInteger(parsed?.round) || !Array.isArray(parsed?.findings)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** 没有上一轮就是第 1 轮。**不猜**：读不到 state 一律从 1 起。 */
export function nextRound(prior: ReviewState | undefined): number {
  return (prior?.round ?? 0) + 1;
}

/** 这一轮的目标，接在共用报告契约后面。 */
export function roundPrompt(round: number, prior: readonly StateFinding[]): string {
  if (round <= 1 || prior.length === 0) {
    return [
      `这是第 ${round} 轮，也是第一轮：**广**撒网。`,
      "把你能确证的问题都列出来，之后的轮次会以收敛为主，不会再有这样一次全面扫描。",
    ].join("\n");
  }
  return [
    `这是第 ${round} 轮（上限 ${ROUND_CAP}）。**主目标是判定上一轮的每一条是否已修**，`,
    "不是重新全面扫描。你的目标函数是收敛。",
    "",
    "先输出一节 `Prior findings:`，**上一轮每一条都要有一行**，格式：",
    "- [fixed|open|regressed] <id> <一句话理由>",
    "漏掉任何一条都算未收敛 —— 「这轮没话说」不等于「已经修好」。",
    "",
    "上一轮的条目：",
    ...prior.map((f) => `- ${f.id} [${f.severity}] ${f.title} — ${f.file}:${f.line ?? ""}`),
    "",
    "然后照常输出 `Full review comments:`。**这一轮只报 P1 级别的新问题**——",
    "其余新发现的问题请不要在这里报（它们会被记为 deferred，留到本轮收敛之后）。",
  ].join("\n");
}

// charset not \S+ (#6064 CJK/colon). Optional `*_ wrap + * bullets — LLM reviewers wrap ids.
// Id class is [A-Za-z0-9]+ (findingId = f + base36). `_`/`-` in the class ate wrapping `_id_`.
const DISPOSITION_RE = /^[-*]\s*\[(fixed|open|regressed)\]\s+[`*_]*([A-Za-z0-9]+)/;

/** 判定表从报告里解析——格式是契约的一部分，不是随便写写。 */
export function parsePriorDispositions(report: string): Map<string, Disposition> {
  const out = new Map<string, Disposition>();
  const start = report.indexOf("Prior findings:");
  if (start < 0) return out;
  const endIdx = report.indexOf(SECTION, start);
  const body = report.slice(start, endIdx < 0 ? undefined : endIdx);
  for (const line of body.split("\n")) {
    const m = DISPOSITION_RE.exec(line.trim());
    if (m) out.set(m[2], m[1] as Disposition);
  }
  return out;
}

/**
 * 「漏判」的两种颜色：parsed 空 = reviewer 没写判定行；parsed 非空但对不上 = 解析没吃对。
 * 只报「漏判 N」时两者同色（#6064）。
 */
export interface DispositionParseDiag {
  expected: string[];
  parsed: string[];
  unmatched: string[];
}

export function dispositionParseDiag(
  expectedIds: readonly string[],
  dispositions: ReadonlyMap<string, unknown>,
): DispositionParseDiag {
  const expected = [...expectedIds];
  const parsed = [...dispositions.keys()];
  const unmatched = expected.filter((id) => !dispositions.has(id));
  return { expected, parsed, unmatched };
}

export function formatDispositionParseDiag(d: DispositionParseDiag): string {
  const list = (ids: readonly string[]) => (ids.length ? ids.join(", ") : "(none)");
  // No leading indent — 4+ spaces is a GitHub code block. Stderr caller indents if needed.
  return [
    `期望上一轮 id：${list(d.expected)}`,
    `解析出的判定 id：${list(d.parsed)}`,
    `对不上：${list(d.unmatched)}`,
  ].join("\n");
}

export interface Convergence {
  converged: boolean;
  /** 上一轮里**没有被判定**的 —— 静默不算收敛。 */
  unadjudicated: string[];
  open: string[];
  regressed: string[];
  /** 这一轮新报的 P1：严重到可以打断收敛。 */
  newP1: string[];
  /** 这一轮新报的非 P1：记下来，但不打断收敛（防漂移）。 */
  deferred: string[];
}

/**
 * 下一轮账本 = **这一轮的 finding** ∪ **上一轮里还没了结的那些**（#5697 review P1）。
 *
 * 以前写进 state 的只有 `toStateFindings(i.findings)` —— 只有这一轮报出来的。
 * 于是第 2 轮判「上一轮的 X 仍 open」但没把 X 重列一遍时，**X 就从账本里消失了**：
 * 第 3 轮无从判定它，`unadjudicated` 是空的，于是**静默「收敛」**。
 * 「已经修好」与「掉出账本了」在下一轮的输入上同色。
 *
 * 带过去的是 `unadjudicated ∪ open ∪ regressed` —— 三者都是**没了结**。
 * `fixed` 不带（它了结了），这一轮的新条目照常进。按 id 去重，这一轮的版本优先
 * （行号可能变了，以最新一次看到的为准）。
 */
export function nextRoundState(
  prior: readonly StateFinding[],
  conv: Convergence | undefined,
  findings: readonly ReviewFinding[],
): StateFinding[] {
  const fresh = toStateFindings(findings);
  if (!conv) return fresh;
  const unresolved = new Set([...conv.unadjudicated, ...conv.open, ...conv.regressed]);
  const freshIds = new Set(fresh.map((f) => f.id));
  const carried = prior.filter((f) => unresolved.has(f.id) && !freshIds.has(f.id));
  return [...carried, ...fresh];
}

export function convergence(
  prior: readonly StateFinding[],
  dispositions: ReadonlyMap<string, Disposition>,
  newFindings: readonly ReviewFinding[],
): Convergence {
  const unadjudicated = prior.filter((f) => !dispositions.has(f.id)).map((f) => f.id);
  const open = prior.filter((f) => dispositions.get(f.id) === "open").map((f) => f.id);
  const regressed = prior.filter((f) => dispositions.get(f.id) === "regressed").map((f) => f.id);
  const ids = withIds(newFindings);
  /**
   * #5697 第 4 轮 review 的 P1 —— **`!== "P1"` 把「更重的」和「不认识的」一起当成
   * 「可以推迟」。**
   *
   * 契约声明的严重度只有 P1/P2/P3，而解析器的正则是 `P\d`：一个 **P0**（比 P1 更重）
   * 落进 `deferred`，第 2 轮起就变成 PASS。实测：
   *
   *     新 finding 严重度 P1 → newP1=1 deferred=0 converged=false 判决=BLOCKED
   *     新 finding 严重度 P0 → newP1=0 deferred=1 converged=true  判决=PASS   ← 更重却放行
   *     新 finding 严重度 P9 → 同上
   *     新 finding 严重度 PX → 同上
   *
   * **「不是 P1」被读成了「不严重」。** 只要 reviewer 用了契约之外的标记，
   * 再重的问题都会被放行 —— 而那正是放行合并的那个答案。
   *
   * 改成白名单：只有**契约明说可以推迟的** P2/P3 才 deferred，其余（P1、P0、
   * 任何不认识的）一律打断收敛。不认识的严重度是**证据不可解**，不是「轻微」。
   */
  const DEFERRABLE = new Set(["P2", "P3"]);
  const blocking = ids.filter((f) => !DEFERRABLE.has(f.severity.toUpperCase()));
  const newP1 = blocking.map((f) => f.id);
  const deferred = ids.filter((f) => DEFERRABLE.has(f.severity.toUpperCase())).map((f) => f.id);
  return {
    converged:
      unadjudicated.length === 0 &&
      open.length === 0 &&
      regressed.length === 0 &&
      newP1.length === 0,
    unadjudicated,
    open,
    regressed,
    newP1,
    deferred,
  };
}

export interface RoundVerdictInput extends ReviewResultInput {
  round: number;
  convergence?: Convergence;
}

/**
 * 第 N 轮的 PASS **必须由收敛证明**，不是「这轮没报东西」。
 * 到了轮次上限仍未收敛 → BLOCKED 且要人介入（不是继续无限跑）。
 */
export function reviewResultForRound(i: RoundVerdictInput): {
  result: "PASS" | "FAIL" | "BLOCKED";
  escalate: boolean;
} {
  // BLOCKED 的两个来源（无法解析 / 独立性不成立）在任何轮次都压过一切：
  // 证据没能成立，不是「断言失败」。
  if (i.unparseable) return { result: "BLOCKED", escalate: false };
  if (!crossEngineVerdict(i.reviewerEngine, i.subjectEngine).ok) {
    return { result: "BLOCKED", escalate: false };
  }
  // 第 1 轮（或拿不到收敛结论）：有 finding 就是 FAIL —— 没有上一轮可判定。
  if (i.round <= 1 || !i.convergence) return { result: reviewResult(i), escalate: false };

  /**
   * #5697 review P2 —— 第 2 轮起，判决**由收敛决定**，不由「这轮报了几条」。
   *
   * 旧写法先算 `reviewResult(i)`，而它只要有 finding 就 FAIL 并**直接返回**，于是
   * `Convergence.deferred`（「这一轮新报的非 P1：记下来，但不打断收敛（防漂移）」）
   * **是死代码** —— 那句注释描述的行为一次都没发生过。
   *
   * 这不是放松：deferred 的条目会进本轮 findings、进账本，**下一轮必须逐条判定**
   * （`nextRoundState` 带过去，`unadjudicated` 会把漏判的挡下来）。打断收敛的只有
   * 新的 P1、以及上一轮没了结的那些。
   */
  if (i.convergence.converged) return { result: "PASS", escalate: false };
  /**
   * 未收敛：到顶就挂起找人，没到顶就照常挡住等下一轮。
   *
   * #5697 review P2 —— 边界是 `>=` 不是 `>`。`ROUND_CAP = 3` 声明的是「第 3 轮是
   * 上限」，而 `round > ROUND_CAP` 在第 3 轮是假：**声明的上限在它自己那一轮不生效**，
   * 要到第 4 轮才叫人。「到顶了」与「还没到顶」在边界那一轮同色。
   */
  return { result: "BLOCKED", escalate: i.round >= ROUND_CAP };
}

/* ===== coder 引擎的来源 ===== */

export type EngineSource = "run-record" | "commit-trailer" | "none";

/**
 * Not an engine. `git log` of the head object failed, threw, or the id was not
 * 40 lowercase hex. Distinct from "the commit names no engine" (`undefined`).
 */
export const TRAILER_UNREADABLE = "\u0000trailer-unreadable";

export interface CoderEngineClaim {
  engine?: string;
  /** 与 `engine` 同一集合，拆开的形式。单引擎 PR 是单元素。 */
  engines?: string[];
  source: EngineSource;
  /** 由**被审者改不到的**来源证实。false = 只是它自己的声明。 */
  attested: boolean;
  /** 两个来源矛盾 —— 证据被动过的信号，比「哪个为准」更重要。 */
  conflict?: { attested: string; claimed: string };
  /**
   * The head object could not be shown. Not `source: "none"` — absence of
   * trailers is a successful read that named no engine.
   */
  unreadable?: boolean;
}

/**
 * coder 引擎该信谁（#5700）。
 *
 * 1. **有 run 记录就以它为准**，标 `attested`。与正文不相交 = 硬拦，`engine` 不给值。
 *    trailer 不能把这条改掉。
 * 2. **没有 run 记录，head 的 trailer 集合就是 coder 集合**，但 `attested: false`。
 *    改 trailer 要换被审的 SHA，所以正文改 `engine:` 或删掉身份行都不改这个集合，
 *    也不让门不适用。写成 trailer 的人就是这颗 SHA 的作者，所以它不是「另一个引擎
 *    写的」的证明：同引擎 review 仍然硬拦，异引擎 review 也不能因此 PASS。
 *    正文与 trailer 不一致时不掏空集合——掏空会让一次 `gh pr edit --body` 把本来
 *    同引擎的 review 从硬拦变成另一条路。
 * 3. **两个都没有 → `source: "none"`**。不退回正文。缺席不是「另一个引擎审过」。
 */
/**
 * 这道跨引擎 review 闸**适不适用**于这条 PR —— 抽成纯函数，因为它的输入强度完全
 * 不同，而合成它们的那行逻辑以前埋在 `merge-gate.ts` 的主流程里、测不到。
 *
 * - `authored` 读的是 **PR 正文**的身份行 —— 被审方自己写的，一条
 *   `gh pr edit --body` 就能删。
 * - `claim.source === "run-record"` 读的是**工厂写的 run 记录** —— 被审方碰不到。
 * - `factoryVisible` 是**这个进程能不能看见工厂 run 记录**（arc 侧
 *   `resolveStateDirs().length > 0`）。它不判定任何 PR，只区分下面那两种「不适用」。
 *
 *   来源是**进程身份，不是机器配置**：工厂 spawn 一个 code agent 时由
 *   `code-agents` 的 `childEnv()` 注入 `ARC_CODE_AGENT_STATE_DIR`，并对嵌套的
 *   非工厂进程主动删除它。所以「看得见」≡「我是工厂派出的那个 agent」。
 *   在开发机上手跑（`land` / 本机 `epic-conductor`）自然看不见——**那是设计，
 *   不是配置缺失**。别照着开发机上的一次 `resolveStateDirs() == []` 就推断这道门坏了。
 *
 * ## 适用范围 = 不可伪造的 coder 集合（run 记录，或被审 head 的 commit trailer）
 *
 * 正文里的身份行不再决定范围：`gh pr edit --body` 删掉它，trailer 仍在的 PR 门照样跑。
 * 既没有 run 记录、head 上也没有引擎 trailer 的 attended 路径仍然不适用（arc#6255：
 * 在那里强制会让每次修复作废发现它的 review）。**不取 `skill:` 字段**——那和身份行
 * 一样住在正文里。
 *
 * ## 收窄之后必须补的洞：「不是工厂的」不能和「看不见工厂」同色
 *
 * run 记录靠 `ARC_WORKER_HOMES` / `ARC_CODE_AGENT_STATE_DIR` 才找得到。这两个 env
 * 没设、head 上也没有引擎 trailer 时，`claim.source` 不是 `run-record` 也不是
 * `commit-trailer`。那时「这条 PR 不归它管」与「这台机器根本没在数」必须分色
 * （`factory-not-visible`）。有 trailer 的 PR 不走这条：commit 对象在，门适用。
 *
 * 判定顺序是刻意的：人写的 PR 在**任何** runner 上都读 `not-agent-authored`，
 * 不会因为这台机器看不见工厂就被标成「工厂不可见」——那会让真正的盲区淹没在噪声里。
 */
export function reviewGateApplies(
  authored: { required: boolean },
  claim: CoderEngineClaim,
  factoryVisible: boolean,
): {
  required: boolean;
  why:
    | "run-record"
    | "commit-trailer"
    | "not-agent-authored"
    | "not-factory"
    | "factory-not-visible";
} {
  if (claim.source === "run-record") return { required: true, why: "run-record" };
  // Trailer evidence is bound to the SHA. Deleting the identity line must not
  // skip the door, and a runner that cannot see factory state still has the commit.
  if (claim.source === "commit-trailer") return { required: true, why: "commit-trailer" };
  if (!authored.required) return { required: false, why: "not-agent-authored" };
  if (!factoryVisible) return { required: false, why: "factory-not-visible" };
  return { required: false, why: "not-factory" };
}

export function coderEngineClaim(
  attestedEngine: string | undefined,
  prBody: string | undefined,
  trailerEngine?: string | undefined,
): CoderEngineClaim {
  // Checked before parseEngineSet: the sentinel is not an engine name, and a
  // failed read must not fall through to source "none" (that skips the door).
  if (trailerEngine === TRAILER_UNREADABLE) {
    return { source: "commit-trailer", attested: false, unreadable: true };
  }
  const attestedSet = parseEngineSet(attestedEngine);
  const claimedSet = parseEngineSet(
    prBody === undefined ? undefined : agentAuthored(prBody).coderEngine,
  );
  const trailerSet = parseEngineSet(trailerEngine);
  if (attestedSet.length && claimedSet.length) {
    const claimedNames = new Set(claimedSet);
    const disjoint = attestedSet.every((e) => !claimedNames.has(e));
    if (disjoint) {
      return {
        source: "run-record",
        attested: false,
        conflict: { attested: attestedSet.join("+"), claimed: claimedSet.join("+") },
      };
    }
  }
  if (attestedSet.length) {
    return {
      engine: attestedSet.join("+"),
      engines: attestedSet,
      source: "run-record",
      attested: true,
    };
  }
  // No factory run. The body is not a source: adopting it, or withholding the
  // trailer set because the body disagrees, both let `gh pr edit --body` change
  // the decision. The trailer set stands. See the accept path on #5700.
  if (trailerSet.length) {
    return {
      engine: trailerSet.join("+"),
      engines: trailerSet,
      source: "commit-trailer",
      attested: false,
    };
  }
  return { source: "none", attested: false };
}
