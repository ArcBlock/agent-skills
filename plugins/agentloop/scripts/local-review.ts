#!/usr/bin/env bun
/**
 * local-review —— 在 **coder 自己的工作树里**跑一个**不同类型**的 agent 做 review，
 * 把结论作为 sticky comment 交付，供 merge-gate 的第五道门读（#5688）。
 *
 *   bun .claude/plugins/agentloop/scripts/local-review.ts --pr 5685 [--post]
 *     --engine <id>          reviewer 引擎（省略则挑一个与 coder **不同**的已注册引擎；未注册会抛错，绝不猜）
 *     --subject-engine <id>  coder 引擎（默认从 PR 正文的 agentloop 身份行读）
 *     --base <ref>           review 的基线（默认 origin/main）
 *     --post                 交付 sticky comment（不带则只打印）
 *
 * **cwd 就是被审的工作树** —— 不 clone、不 install。树已在被审 SHA 上、依赖已装好，
 * 这是 coder 与 reviewer 同 worker 的全部理由。只读沙箱不是可选项：reviewer 能写就
 * 可能改坏被审的代码。带 `--pr` 时 **HEAD 必须等于该 PR 的 head**（spawn 之前断言，
 * 与是否 `--post` 无关）——否则审的是另一份 diff，输出却像真 review（arc#6195）。
 *
 * 判决由 `reviewResult` 编进 marker 的 `result=`：同引擎 / 独立性未知 / 输出无法解析
 * 一律 `BLOCKED`。`requireStickyGate` 只接受 {PASS, NA}，所以第五道门零新逻辑。
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { postOnce } from "../lib/comment.ts";
import {
  assertCwdIsPrHead,
  assertReviewerEngine,
  collectReviewOutput,
  contractRetryPrompt,
  convergence,
  dispositionParseDiag,
  formatDispositionParseDiag,
  formatReviewRawArtifact,
  fulfillReviewContract,
  LOCAL_REVIEW_PREFIX,
  nextRound,
  parseCodexReview,
  parsePriorDispositions,
  parseReviewState,
  persistReviewRaw,
  pickDefaultReviewer,
  REVIEW_OUTPUT_SCHEMA,
  ROUND_CAP,
  renderReviewComment,
  reportContractWithNonce,
  resolveSubjectEngine,
  reviewerArgv,
  reviewerAttemptCountsRound,
  reviewResultForRound,
  roundPrompt,
  type StateFinding,
  setReviewerEngines,
} from "../lib/local-review.ts";
import { run } from "../lib/report.ts";

/** 报告契约 + **这一轮的目标**。引擎不知道报告长什么样，由这里给。 */
function reviewPrompt(
  base: string,
  round: number,
  prior: readonly StateFinding[],
  title: string | undefined,
  nonce: string,
): string {
  return [
    `你是这个仓库的独立 code reviewer。审查 \`${base}...HEAD\` 的改动${title ? `（${title}）` : ""}。`,
    "先用 git 看清 diff，再读被改文件的上下文。只报**具体的、能说出怎么会错**的问题；",
    "没有问题就说没有，不要为了凑数而写。",
    "",
    roundPrompt(round, prior),
    "",
    reportContractWithNonce(nonce),
  ].join("\n");
}

const argv = process.argv.slice(2);
const flag = (name: string, dflt?: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};

const pr = flag("--pr");
const engineFlag = flag("--engine");
// base 优先取 PR 自己的 base 分支：写死 origin/main 在 master 默认分支的仓库上是个
// 不存在的 ref，在 stacked PR 上会把不属于这个 PR 的 commit 一起审（插件第一原则）。
let base = flag("--base") as string | undefined;
const post = argv.includes("--post");

if (!base && pr) {
  const b = run(`gh api "repos/{owner}/{repo}/pulls/${pr}" --jq .base.ref`);
  if (b.code !== 0) {
    // #5697 review P2 —— **查不到 base ≠ base 是 main**。上面那段注释自己说了理由
    // （master 默认分支、stacked PR），却又在下一行 `?? "origin/main"` 把它猜回来。
    // 猜错的后果不是报错，是**审了错误的范围**然后给出一个看起来正常的判决。
    console.error(
      `✗ 读不到 PR #${pr} 的 base 分支（gh 退出 ${b.code}）—— 停。\n` +
        `  「查不到」不是「是 main」：猜错了会审错范围，而判决看起来一切正常。\n` +
        `  要么修好 gh，要么显式 --base <ref>。\n` +
        `  ${(b.out ?? "").trim().split("\n")[0]}`,
    );
    process.exit(2);
  }
  if (b.out.trim()) base = `origin/${b.out.trim()}`;
}
// 没有 --pr 也没有 --base 时才回落 —— 那是本地跑，范围由使用者自己定。
base = base ?? "origin/main";

/**
 * **把 base 刷新并固定成一个不可变的 SHA**（#5697 review P1：`fa8xwo` / `fw8st83`）。
 *
 * 在这之前 `base` 全程是一个**可变的分支引用**（`origin/main`），两个后果：
 *
 *   1. 本地 tracking ref 落后于远端时，reviewer **审的是过期范围** —— 而它给出的是一个
 *      看起来完全正常的 PASS。「审过了」与「审的是旧的」同色。
 *   2. marker 里只记分支名，**事后无法证明这一轮实际审的是哪个 base**。
 *
 * 两步都 fail-closed，理由和这个文件里已有的两处先例一样（读不到旧 comment、
 * 读不到 PR base）：**读不到 ≠ 可以按默认继续**。
 */
{
  const remoteRef = base.startsWith("origin/") ? base.slice("origin/".length) : undefined;
  if (remoteRef) {
    const fetched = run(`git fetch origin ${remoteRef}`);
    if (fetched.code !== 0) {
      console.error(
        `✗ 取不到 origin/${remoteRef} 的最新提交（git fetch 退出 ${fetched.code}）—— 停。\n` +
          `  本地 ref 可能落后：那样 reviewer 审的是过期范围，却会给出一个正常的 PASS。\n` +
          `  ${(fetched.out ?? "").trim().split("\n")[0]}`,
      );
      process.exit(2);
    }
  }
  const resolved = run(`git rev-parse ${base}`);
  const sha = resolved.code === 0 ? resolved.out.trim() : "";
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    console.error(
      `✗ 解析不出 ${base} 的提交 SHA（git rev-parse 退出 ${resolved.code}）—— 停。\n` +
        `  不固定成 SHA 的话，「这一轮审的是哪个 base」事后无法核对。`,
    );
    process.exit(2);
  }
  // 从这里往下，base 是一个不可变的提交。prompt、marker、state 拿到的都是它。
  base = sha;
}
const reviewBase: string = base;

/**
 * 引擎表从**消费仓库**装载（repo-profile 的 `reviewer_engines` 指到一个模块）。
 * 插件自带空表——引擎的值属于消费仓库，装不到就 fail-closed，不退回任何默认。
 */
{
  let modPath: string | undefined;
  try {
    const prof = readFileSync(".claude/repo-profile.md", "utf8");
    modPath = /reviewer_engines[`*\s:|]+([^\s|`]+)/.exec(prof)?.[1];
  } catch {
    /* 没有 profile */
  }
  if (!modPath) {
    console.error(
      "✗ repo-profile 没有 `reviewer_engines`（指向本仓库的引擎表模块）—— 插件不自带引擎表",
    );
    process.exit(2);
  }
  const mod = await import(resolve(modPath));
  if (!mod.REVIEWER_ENGINES) {
    console.error(`✗ ${modPath} 没有导出 REVIEWER_ENGINES`);
    process.exit(2);
  }
  setReviewerEngines(mod.REVIEWER_ENGINES);
}

/**
 * 上一轮的账本就在那条 sticky comment 里。
 *
 * #5697 review P1 —— **读不到 ≠ 没有**。旧写法是 `if (code === 0 && out)`，于是
 * 一次瞬时的 API 失败被静默读成「这是第 1 轮」：上一轮所有未了结的 finding 就此
 * 蒸发，接着一条干净的 PASS 覆盖上去，**没有任何一条被判定过**。
 *
 * 三种状态必须分开（以前后两种同色）：
 *   读成功 + 没有 comment  → 真的是第 1 轮
 *   读成功 + 有 comment    → 解析它
 *   **读失败**             → 停，非零退出。不猜。
 */
let priorState: ReturnType<typeof parseReviewState>;
if (pr) {
  const prev = run(
    `gh api --paginate "repos/{owner}/{repo}/issues/${pr}/comments" ` +
      `--jq '[.[] | select((.body // "") | startswith("<!-- local-review"))][-1].body // empty'`,
  );
  if (prev.code !== 0) {
    console.error(
      `✗ 读不到 PR #${pr} 的既有 review comment（gh 退出 ${prev.code}）—— 停。\n` +
        `  「读不到」不是「没有」：当成第 1 轮会让上一轮未了结的 finding 静默消失，\n` +
        `  再被一条没判定过任何东西的 PASS 覆盖掉。\n` +
        `  ${(prev.out ?? "").trim().split("\n")[0]}`,
    );
    process.exit(2);
  }
  if (prev.out.trim()) {
    priorState = parseReviewState(prev.out);
    if (!priorState) {
      /**
       * #5697 第 2 轮 review 的 P2 —— **读到了但解析不了 ≠ 没有。**
       *
       * comment 存在（`prev.out` 非空）却解析不出 state：JSON 被截断、格式漂移、
       * 或者旧版本写的。旧写法在这里静默让 `priorState` 保持 undefined ⇒ 从第 1 轮
       * 重开 ⇒ upsert **覆盖掉那条 comment** ⇒ 上一轮所有未了结的 finding
       * **一条都没被判定过就消失了**。
       *
       * 这和上面那个「读失败」是同一个洞的两半：一半是拿不到，一半是拿到了读不懂。
       * 两半都必须 fail-closed。
       */
      console.error(
        `✗ PR #${pr} 上的 review comment 存在，但解析不出轮次账本 —— 停。\n` +
          `  「解析不了」不是「没有」：当成第 1 轮会覆盖掉它，而上一轮未了结的\n` +
          `  finding 一条都没被判定过。\n` +
          `  若是旧格式需要迁移，显式处理它，不要靠静默重置。`,
      );
      process.exit(2);
    }
  }
}
const round = nextRound(priorState);
const prior = priorState?.findings ?? [];

const sha = run("git rev-parse HEAD").out.trim();
// 脏树上的 review 覆盖的**不是** HEAD 的内容，而 marker 会声称它覆盖了 —— 那是
// 「证据被安到它没测过的东西上」。同 `pre-pr.ts` 只在树干净时才写 .verify/<sha>.md。
const dirty = run("git status --porcelain").out.trim();
if (!/^[0-9a-f]{40}$/.test(sha)) {
  console.error("✗ 取不到 HEAD sha —— cwd 必须是被审的工作树");
  process.exit(2);
}
/**
 * arc#6195 —— **在 spawn 之前**确认 cwd HEAD 就是这个 PR 的 head。
 *
 * 旧位置在 `--post` 交付前、引擎跑完之后：wrong-cwd 会先烧掉一整轮 reviewer
 * （实测 1288s），不带 `--post` 时则静默给出一份格式合法的错 review。
 * 「读不到 PR head」也停：猜成当前 HEAD 会审错范围，而判决看起来一切正常。
 */
if (pr) {
  const headGate = assertCwdIsPrHead({
    pr,
    localSha: sha,
    cwd: process.cwd(),
    runner: run,
  });
  if (!headGate.ok) {
    console.error(headGate.reason);
    process.exit(2);
  }
}

// coder 引擎**只能**来自 PR 自己记录的身份行。`--subject-engine` 只能确认、不能改写
// ——否则一个 codex 作者用 codex reviewer 加 `--subject-engine claude` 就能造出
// PASS marker，那是闸自己的绕过口（本地跨引擎 review 报的 P1）。
let subjectEngine: string | undefined;
{
  const body = pr
    ? run(`gh api "repos/{owner}/{repo}/pulls/${pr}" --jq .body 2>/dev/null`)
    : undefined;
  const resolved = resolveSubjectEngine(
    body && body.code === 0 ? body.out : undefined,
    flag("--subject-engine"),
  );
  if (resolved.ok) subjectEngine = resolved.engine;
  else console.error(`⚠ coder 引擎未确定：${resolved.reason} —— 判决将是 BLOCKED`);
}

/**
 * #5697 f1gtawqv —— 省略 `--engine` 不得默认 codex。
 *
 * 写死 codex 会让每一个 `engine:codex` 的 PR 在 merge-gate 印出的重跑命令下
 * 永远 same-engine BLOCKED。默认必须挑一个**与 coder 不同**的已注册引擎。
 */
const engineRaw = engineFlag ?? pickDefaultReviewer(subjectEngine);
if (!engineRaw) {
  console.error(
    "✗ 没有可用的跨引擎 reviewer —— 停。\n" +
      `  coder 引擎是 ${subjectEngine ?? "(未声明)"}。省略 --engine 时必须能从注册表里挑一个不同的。\n` +
      "  显式传 --engine <id>，或先把 coder 引擎写进 PR 身份行 / 工厂 run 记录。",
  );
  process.exit(2);
}
const engine: string = engineRaw;

// `-o` 把 review 正文单独写出来。不这么做就得从 stdout 里捞，而 stdout 混着
// reviewer 的事件流——实测那会被当成 finding 正文吞进去，评论超过 GitHub 的
// 65536 上限，交付直接 422。
// arc#6123:每轮一个一次性 nonce。引擎原样复制它 = 这份输出没被截断,于是「完整且
// 零条」与「没跑完」不再同色。**每轮重新生成**——复用会让上一轮的复述冒充这一轮。
const nonce = `arc-review-nonce-${randomBytes(8).toString("hex")}`;
const tmpDir = mkdtempSync(join(tmpdir(), "local-review-"));
const outFile = join(tmpDir, "review.md");
const retryFile = join(tmpDir, "review.retry.md");
const schemaFile = join(tmpDir, "review.schema.json");
writeFileSync(schemaFile, `${JSON.stringify(REVIEW_OUTPUT_SCHEMA, null, 2)}\n`);
const spec = assertReviewerEngine(engine);
const timeoutMs = Number(flag("--timeout-ms", "1800000"));
const prompt = reviewPrompt(base, round, prior, pr ? `PR #${pr}` : undefined, nonce);

function spawnOnce(
  reviewerPrompt: string,
  dest: string,
): {
  stdout: string;
  failed: boolean;
  collected: ReturnType<typeof collectReviewOutput>;
} {
  const cmd = reviewerArgv(engine, {
    prompt: reviewerPrompt,
    base: reviewBase,
    outFile: dest,
    schemaFile,
    ...(pr ? { title: `PR #${pr}` } : {}),
  });
  console.error(`▶ ${cmd.join(" ")}   (cwd=${process.cwd()})`);
  // #6172：两条输出管子都 pipe。stderr inherit 时 grok-build 的模型原文只要打到
  // stderr 就丢了；file 模式 stdout inherit 时，-o 没写成、答案在 stdout 同样丢。
  // spawnSync 不直播，结束后把 stderr（以及 file 模式的 stdout 事件流）回放到父进程。
  const bin = cmd[0];
  if (!bin) throw new Error("reviewerArgv returned empty argv");
  const proc = spawnSync(bin, cmd.slice(1), {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // 没有超时的 reviewer 会让无人值守 worker 永远挂住 —— 而**沉默**正是这道门整个
    // 设计要消灭的那种失效。超时按 unparseable 处理（BLOCKED），不是「没发现问题」。
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutCap = proc.stdout ?? "";
  const stderrCap = proc.stderr ?? "";
  if (stderrCap) process.stderr.write(stderrCap);
  if (spec.outputMode === "file" && stdoutCap) process.stderr.write(stdoutCap);
  const collected = collectReviewOutput({
    outputMode: spec.outputMode,
    stdout: stdoutCap,
    stderr: stderrCap,
    outFileText: spec.outputMode === "file" && existsSync(dest) ? readFileSync(dest, "utf8") : "",
  });
  const failed = Boolean(proc.error) || proc.signal !== null || (proc.status ?? 1) !== 0;
  if (failed) {
    console.error(
      `⚠ reviewer 进程未正常结束（status=${proc.status} signal=${proc.signal} ${proc.error?.message ?? ""}）`,
    );
  }
  return { stdout: collected.text, failed, collected };
}

const started = Date.now();
const first = spawnOnce(prompt, outFile);

// 仓库根显式传给解析器：路径的相对化不靠猜（本地 codex 自审时报的 P2）。
const repoRoot = run("git rev-parse --show-toplevel").out.trim();

/**
 * **把 reviewer 的原始输出留在盘上**（#5697 第 3 轮实盘）。
 *
 * 它原来写在一个 `mkdtemp` 里，读完即弃。于是这一轮出现「上一轮 8 条一条都没被判定」
 * 时，**没有任何东西能区分**：
 *
 *   - reviewer 压根没写 `Prior findings:` 一节，还是
 *   - 它写了，但格式不合 `DISPOSITION_RE`，解析器没认出来
 *
 * 两者在报告上是同一句「漏判 8」，而修法完全相反（一个改 prompt，一个改解析器）。
 * 落盘的路径打在 stderr 上，判决非 PASS 时尤其要看它。
 */
const rawPath = join(process.cwd(), ".verify", `local-review-${Date.now()}.raw.md`);
const persistAttempt = (
  attempt: { collected: ReturnType<typeof collectReviewOutput> },
  destPath: string,
) => {
  const persisted = persistReviewRaw({
    destPath,
    modelText: attempt.collected.text,
    artifact: formatReviewRawArtifact(attempt.collected, { engine }),
  });
  if (persisted.error) {
    console.error(`⚠ 原文落盘失败：${persisted.error}`);
  } else {
    console.error(
      `↳ reviewer 原始输出：${persisted.path}${persisted.preserved ? `（${persisted.bytes} 字节）` : "（空 — 未接到模型原文）"}`,
    );
  }
  return persisted;
};
// #6172：解析之前无条件落盘。preserved 看模型原文，不看文件是否被创建。
let raw = persistAttempt(first, rawPath);
const fulfilled = fulfillReviewContract({
  nonce,
  ...(repoRoot ? { repoRoot } : {}),
  first,
  retry: () => {
    console.error("⚠ reviewer 输出无法解析 —— 按契约重试一次（arc#6187）");
    const second = spawnOnce(contractRetryPrompt(nonce, prompt), retryFile);
    raw = persistAttempt(
      second,
      join(process.cwd(), ".verify", `local-review-${Date.now()}.raw.md`),
    );
    return second;
  },
});
const stdout = fulfilled.stdout;
const procFailed = fulfilled.failed;
// arc#7399: a dead process with no nonce did not run. Do not print a
// round-advancing body and do not upsert — that would burn a round and
// replace the previous review comment.
if (!reviewerAttemptCountsRound({ failed: procFailed, stdout, nonce })) {
  console.error(
    "reviewer 未运行（进程非正常结束，且输出没有本轮 nonce）—— 不计入 round，不覆盖已有 review comment。",
  );
  process.exit(2);
}
const parsed = parseCodexReview(stdout, repoRoot ? { repoRoot, nonce } : { nonce });
const findings = parsed.findings;
const unparseable = !parsed.ok || procFailed;
// 第 N 轮的判决必须由**收敛**证明，不是「这轮没报东西」。
const dispositions = parsePriorDispositions(stdout);
const conv = round > 1 && prior.length ? convergence(prior, dispositions, findings) : undefined;
const parseDiag = prior.length
  ? dispositionParseDiag(
      prior.map((f) => f.id),
      dispositions,
    )
  : undefined;
if (dirty) console.error(`⚠ 工作树不干净（${dirty.split("\n").length} 个文件）—— 判决降为 BLOCKED`);
const body = renderReviewComment({
  reviewerEngine: engine,
  subjectEngine,
  sha,
  base,
  findings,
  round,
  ...(conv ? { convergence: conv } : {}),
  ...(prior.length ? { prior } : {}),
  ...(parseDiag ? { parseDiag } : {}),
  unparseable: unparseable || dirty.length > 0,
  raw,
  ...(!parsed.ok ? { parseKind: parsed.kind, excerpt: parsed.excerpt } : {}),
});
const { result: verdict, escalate } = reviewResultForRound({
  reviewerEngine: engine,
  subjectEngine,
  round,
  findings,
  convergence: conv,
  unparseable: unparseable || dirty.length > 0,
});
if (conv && !conv.converged) {
  console.error(
    `⚠ 第 ${round} 轮未收敛 —— 漏判 ${conv.unadjudicated.length} · 仍开 ${conv.open.length} · 回归 ${conv.regressed.length} · 新 P1 ${conv.newP1.length}（deferred ${conv.deferred.length}）`,
  );
  if (conv.unadjudicated.length > 0) {
    // 「漏判」有两种颜色：parsed 空 = reviewer 没写；parsed 非空但对不上 = 解析没吃对。
    // 只报「漏判 N」时两者同色（#6064）。
    console.error(`   ↳ reviewer 原始输出：${rawPath}`);
    if (parseDiag) {
      console.error(
        formatDispositionParseDiag(parseDiag)
          .split("\n")
          .map((l) => `   ${l}`)
          .join("\n"),
      );
      if (parseDiag.parsed.length === 0) {
        console.error("   ↳ 判定行格式：- [fixed|open|regressed] <id> <理由>");
      }
    }
  }
}
if (escalate) {
  console.error(`⚠ 已到轮次上限 ${ROUND_CAP} 仍未收敛 —— 需要人介入，请挂 needs-human-confirm`);
}

console.log(body);
console.error(
  `— ${engine} 审 ${subjectEngine ?? "(未声明)"} · ${findings.length} 条 · 判决 ${verdict} · ${((Date.now() - started) / 1000).toFixed(0)}s`,
);

if (post) {
  if (!pr) {
    console.error("✗ --post 需要 --pr");
    process.exit(2);
  }
  // 再确认一次：review 期间 HEAD 可能被切走。`postOnce` 是 upsert，写错 PR
  // 或错 checkout 会直接覆盖已有证据。spawn 前已断言过；这里挡的是期间漂移。
  const headGate = assertCwdIsPrHead({
    pr,
    localSha: sha,
    cwd: process.cwd(),
    runner: run,
  });
  if (!headGate.ok) {
    console.error(headGate.reason);
    process.exit(2);
  }
  const r = postOnce(pr, body, run, LOCAL_REVIEW_PREFIX);
  if (!r.ok) {
    console.error(`✗ 交付失败: ${r.out.slice(0, 300)}`);
    process.exit(1);
  }
  console.error(`✅ 已交付到 PR #${pr}`);
}

// 退出码反映判决：PASS=0，其余非零。闸自己会再读一遍 comment，这里只是让调用方好判断。
process.exit(verdict === "PASS" ? 0 : 1);
