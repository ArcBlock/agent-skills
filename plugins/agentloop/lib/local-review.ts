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
 * ## 不变量：`reviewer.engine ≠ coder.engine`
 *
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

export type ParseResult =
  | { ok: true; findings: ReviewFinding[] }
  | { ok: false; reason: "unparseable" };

/**
 * 报告契约 —— **所有引擎共用同一份**。
 *
 * 格式是契约：每个适配器负责**产出**它，而不是各带一个解析器各说各话。codex 的
 * `exec review` 天然是这个形状；claude / grok 由提示词要求它照这个形状输出。
 * 解析器因此只有一个（`parseReviewReport`）。
 */
export const REPORT_CONTRACT = [
  "输出格式（严格遵守，不要加别的小节）：",
  "先一段两三句的总结，然后一行 `Full review comments:`，然后每条 finding 一段：",
  "- [P1|P2|P3] <一句话标题> — <仓库相对路径>:<行号或行号区间>",
  "  <两三句说明：具体会怎么错，不是泛泛而谈>",
  "**没有任何问题时**，在 `Full review comments:` 之后只写一行 `(none)` —— 零条必须由",
  "这个哨兵证明，空白不算（空白与「被截断」无法区分）。",
].join("\n");

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
  args(opts: { prompt: string; base: string; title?: string; outFile?: string }): string[];
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
  opts: { prompt: string; base: string; title?: string; outFile?: string },
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
 * 两侧都先对注册表 canonicalize；任一未注册 → `unknown`，不是 cross-engine。
 */
export function crossEngineVerdict(
  reviewerEngine: string | undefined,
  subjectEngine: string | undefined,
): { ok: boolean; reason: CrossEngineReason } {
  const a = canonicalizeEngine(reviewerEngine);
  const b = canonicalizeEngine(subjectEngine);
  if (!a || !b) return { ok: false, reason: "unknown" };
  return a === b ? { ok: false, reason: "same-engine" } : { ok: true, reason: "cross-engine" };
}

/**
 * 省略 `--engine` 时挑一个**已注册且与 coder 不同**的 reviewer（#5697 f1gtawqv）。
 *
 * 写死 `codex` 会让每一个 `engine:codex` 的 PR 在默认命令下 same-engine BLOCKED。
 * coder 未注册 / 表里没有第二个引擎 → `undefined`（调用方 fail-closed，不猜）。
 */
export function pickDefaultReviewer(
  coderEngine: string | undefined,
  table: ReviewerTable = TABLE,
): string | undefined {
  const coder = canonicalizeEngine(coderEngine, table);
  if (!coder) return undefined;
  for (const id of Object.keys(table)) {
    const canonical = canonicalizeEngine(id, table);
    if (canonical && canonical !== coder) return canonical;
  }
  return undefined;
}

/** merge-gate 印在失败提示里的重跑命令。必须带 `--engine`，否则默认又撞上 coder。 */
export function localReviewRerunHint(
  pr: string,
  coderEngine: string | undefined,
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

/**
 * Gate 6 的完整 sticky 检查：sha/result=PASS（不收 NA）+ heading 引擎已注册
 * 且与 coder 跨引擎。GitHub login 只作审计，不是独立性证明。
 */
export function requireLocalReviewSticky(
  pr: string,
  prHead: string,
  rerunHint: string,
  runner: Runner,
  ctx: { prAuthor: string | undefined; coderEngine: string | undefined },
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
  if (!gate.ok) return gate;
  return attestLocalReview({
    body: captured?.body ?? "",
    author: captured?.user?.login,
    prAuthor: ctx.prAuthor,
    coderEngine: ctx.coderEngine,
    prHead,
  });
}

/* ===== codex 产物解析 ===== */

const FINDING_RE = /^-\s*\[(P\d)\]\s*(.+?)\s+—\s+(\S+?):(\d+(?:-\d+)?)\s*$/;
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

export function parseReviewReport(stdout: string, opts: { repoRoot?: string } = {}): ParseResult {
  const idx = stdout.indexOf(SECTION);
  if (idx < 0) return { ok: false, reason: "unparseable" };
  const findings: ReviewFinding[] = [];
  const lines = stdout.slice(idx + SECTION.length).split("\n");
  let current: ReviewFinding | undefined;
  /** 小节里没被任何一条 finding 认领、也不是干净哨兵的实质内容。 */
  let unclaimed = 0;
  /** 是否见到过明确的「这一轮没有 finding」。零条**必须**由它证明。 */
  let sawCleanSentinel = false;
  for (const raw of lines) {
    const m = FINDING_RE.exec(raw.trimEnd());
    if (m) {
      current = {
        severity: m[1],
        title: m[2].trim(),
        file: repoRelative(m[3], opts.repoRoot),
        line: m[4],
        body: "",
      };
      findings.push(current);
      continue;
    }
    const text = raw.trim();
    if (!text) continue;
    if (current && !text.startsWith("-") && !text.startsWith("*")) {
      // 上限是防御性的第二道：即使有一天 reviewer 又把日志混进正文，也不会撑爆交付面。
      if (current.body.length < BODY_CAP) {
        current.body = `${current.body} ${text}`.trim();
        if (current.body.length >= BODY_CAP) {
          current.body = `${current.body.slice(0, BODY_CAP)}… （正文过长，已截断）`;
        }
      }
      continue;
    }
    if (CLEAN_SENTINEL.test(text)) sawCleanSentinel = true;
    else unclaimed++;
  }
  // **零条不等于干净。** 小节里有实质内容却一条都认不出，说明 reviewer 的输出格式
  // 漂了，而不是这一轮没问题——后者会走成 PASS。这是「解析器没看懂」与「审过了、
  // 干净」在小节内部的同色，只在小节头上把关拦不住它（本地 codex 自审时报的 P2）。
  // 零条必须由**明确的哨兵**证明，不能靠「没看见别的东西」推出来：小节头之后什么
  // 都没有（截断的响应、只打了标题就退出的 reviewer）会让 unclaimed 也是 0，
  // 于是「没审完」与「审完了、干净」同色 —— 而干净是那个会放行合并的答案。
  // 这是同一个洞的第三次变形（前两次：没有小节头 / 小节里有认不出的内容）。
  // 两个条件都要：没有哨兵 → 「没看懂」；哨兵之后还有认不出的内容 → 同样是没看懂
  // （否则 `(none)` 后面跟一条格式漂了的 P1 会走成干净）。
  if (findings.length === 0 && (!sawCleanSentinel || unclaimed > 0)) {
    return { ok: false, reason: "unparseable" };
  }
  return { ok: true, findings };
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
}

export function renderReviewComment(i: ReviewCommentInput): string {
  const v = crossEngineVerdict(i.reviewerEngine, i.subjectEngine);
  // **marker 的 result 就是收敛判决**。曾经这里另算一份（只看跨引擎 + 零 finding），
  // 于是第 2 轮未收敛被写成 PASS —— 而第五道门只读 marker，直接放行。
  // 两个真相源里，闸读的那个必须是对的那个。
  const result = reviewResultForRound({ ...i, round: i.round ?? 1 }).result;
  const indep = v.ok
    ? "独立性 **" + v.reason + "**"
    : "独立性 **" + v.reason + "** —— 不满足 `reviewer.engine ≠ coder.engine`，不构成可合并证据";
  // 轮次账本紧跟 marker：JSON 藏在 HTML 注释里是**真相**，下面渲染出来的是派生的
  // （同 comment.ts 的 verify-history 先例——人改了正文不会污染序列）。
  const state =
    i.round === undefined
      ? ""
      : `${renderReviewState({ round: i.round, findings: nextRoundState(i.prior ?? [], i.convergence, i.findings) })}\n`;
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
    "**\n\n";

  if (i.unparseable) {
    return head + "_reviewer 的输出无法解析 —— 这不是「没发现问题」，判 BLOCKED。_\n";
  }
  if (!i.findings.length) return head + "_本轮无 finding。_\n";

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
export function agentAuthored(prBody: string): { required: boolean; coderEngine?: string } {
  const identity = /^>\s*🤖\s*AI Agent\b.*$/m.exec(prBody ?? "");
  if (!identity) return { required: false };
  const engine = normalizeEngine(/\bengine:([A-Za-z0-9._-]+)/.exec(identity[0])?.[1]);
  // engine:unknown 与「没有 engine 字段」同义 —— 都不是一个可以拿来比对的引擎名。
  return { required: true, ...(engine ? { coderEngine: engine } : {}) };
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
  if (!recorded) {
    return {
      ok: false,
      reason: "PR 没有记录 coder 引擎（身份行缺失或没有 engine: 字段），无从核对 —— 覆盖值不算数",
    };
  }
  if (override && override !== recorded) {
    return { ok: false, reason: `--subject-engine ${override} 与 PR 记录的 ${recorded} 矛盾` };
  }
  return { ok: true, engine: recorded };
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

const DISPOSITION_RE = /^-\s*\[(fixed|open|regressed)\]\s+(\S+)/;

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

export type EngineSource = "run-record" | "pr-body" | "none";

export interface CoderEngineClaim {
  engine?: string;
  source: EngineSource;
  /** 由**被审者改不到的**来源证实。false = 只是它自己的声明。 */
  attested: boolean;
  /** 两个来源矛盾 —— 证据被动过的信号，比「哪个为准」更重要。 */
  conflict?: { attested: string; claimed: string };
}

/**
 * coder 引擎该信谁（#5700）。
 *
 * **任何由被审方自己写下的声明都是可伪造的。** PR 正文一条 `gh pr edit --body` 就能改，
 * 整段删掉还能让这道门直接不适用；commit trailer 也一样——agent 控制自己的 commit。
 *
 * 唯一不可伪造的是**工厂侧写的 run 记录**：`worktreeOwner.branch ↔ engine` 由 worker
 * 在派工时写下，被审的 agent 够不到它。
 *
 * 三条规矩：
 *
 * 1. **有 run 记录就以它为准**，标 `attested`。
 * 2. **两个来源矛盾 = 伪造信号**，硬拦。这不是「以哪个为准」的问题——正文被改过这件事
 *    本身就是结论，`engine` 因此不给值，判决落到 BLOCKED。
 * 3. **没有 run 记录就退回正文，但标 `attested: false`**。工厂只能对自己派出去的活强制；
 *    别处来的 PR 它不知道，**如实说 claimed，不假装 attested**。
 */
/**
 * 这道跨引擎 review 闸**适不适用**于这条 PR —— 抽成纯函数，因为它的两个输入
 * 强度完全不同，而合成它们的那行逻辑以前埋在 `merge-gate.ts` 的主流程里、测不到。
 *
 * - `authored` 读的是 **PR 正文**的身份行 —— 被审方自己写的，一条
 *   `gh pr edit --body` 就能删。
 * - `claim.source === "run-record"` 读的是**工厂写的 run 记录** —— 被审方碰不到。
 *
 * #5700 用 run 记录拦住了「篡改成另一个引擎」，却漏了更简单的一手：**把身份行整行
 * 删掉**。那时 `authored.required` 是 false，整道闸直接不适用 ——
 * **「不是 agent 写的」与「是 agent 写的但把证据删了」在那个布尔上同色。**
 * （#5697 自己的 cross-engine review 抓到的 P1。）
 *
 * 所以适用范围取**两者的并**：正文说是，**或者** run 记录说是。`why` 让报告能说清
 * 是哪一边认定的 —— 两种「适用」不该看起来一样。
 */
export function reviewGateApplies(
  authored: { required: boolean },
  claim: CoderEngineClaim,
): { required: boolean; why: "run-record" | "pr-body" | "not-agent-authored" } {
  if (claim.source === "run-record") return { required: true, why: "run-record" };
  if (authored.required) return { required: true, why: "pr-body" };
  return { required: false, why: "not-agent-authored" };
}

export function coderEngineClaim(
  attestedEngine: string | undefined,
  prBody: string | undefined,
): CoderEngineClaim {
  const attested = normalizeEngine(attestedEngine);
  const claimed = normalizeEngine(
    prBody === undefined ? undefined : agentAuthored(prBody).coderEngine,
  );
  if (attested && claimed && attested !== claimed) {
    return { source: "run-record", attested: false, conflict: { attested, claimed } };
  }
  if (attested) return { engine: attested, source: "run-record", attested: true };
  if (claimed) return { engine: claimed, source: "pr-body", attested: false };
  return { source: "none", attested: false };
}
