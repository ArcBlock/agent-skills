# issue-sweep — --autofix-green pipeline (Step 3b)

> On-demand reference for [`issue-sweep`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

### Triage every candidate into 🟢 / 🟡 / 🔴

A 🟢 issue must pass **all four** checks:

1. **Unambiguous** — the fix is determined; no design decision, no A-vs-B, no "should we even do this".
2. **Verifiable in THIS environment** — there is a test or repro you can *actually run* and watch go fail → pass. No runnable proof ⇒ not green. (This is the check that disqualifies most things — see below.)
3. **Low blast radius** — a leaf fix (one handler, one wire field, a missing test, a polyfill). Not core-architecture, not a cross-cutting contract, not a public API shape.
4. **Not security-sensitive** — crypto, auth, token compare, access control, path-traversal guards stay human even when "obvious".

🟡 = mechanical but **fails check 2 or 3**: e.g. native Swift/Kotlin code in a sandbox with no Xcode/Android SDK (can't build/test), or a change that touches CI/build config or a broad surface. → write the fix, open a **draft PR** with evidence, label `needs-human-review`, and **say plainly it is not verified here**. Never auto-merge, never claim a green check you didn't run.

🔴 = needs design direction / architecture / security → **comment only** (the existing Step 3 red row). Do not touch code.

### Verifiability is environment-dependent (and that's the leverage)

The same issue can be 🟡 in one environment and 🟢 in another. In a **TS-only sandbox**, `bun test`/`tsx` run, so TS-side issues with a conformance/unit test are 🟢 — but every Swift/Kotlin parity issue is 🟡 (can't compile). On a **machine that can build all platforms** (`swift test`, `./gradlew test`, YAML-runner-vs-native-server), those native parity issues move 🟡 → 🟢. So the realistic auto-fix coverage ≈ *the fraction of the backlog you can prove a fix for right here*. State which environment you're in and which classes it unlocks.

### Env-capability probe (multi-machine claiming)

Multiple machines run this sweep (cloud routine + one or more local checkouts), and they don't all
have the same toolchains — one local Mac may have a full Swift+Android native build/test
environment, a cloud sandbox is typically TS-only. Before claiming a candidate whose verifiability
depends on a toolchain, run `<capability_probe_script>` (probes actual usability, not just
binary presence — e.g. `native-android` checks the SDK dir + `java`, not just `$ANDROID_HOME` being
set, because that env var is commonly unset in a fresh shell even when the SDK is installed) and
compare against the issue's declared requirement, marked in its body as:

```
<!-- requires: native-ios,native-android -->
```

- **Capability present** → proceed normally (🟢/🟡 checks above still apply).
- **Capability declared but missing here** → this is a *this-environment* verifiability gap, not a
  design gap: leave the issue untouched and silent (per the "🟢 candidate, no capacity this round"
  silence rule below) rather than downgrading it to 🟡/`needs-human-review` — a different machine's
  next sweep run may have the capability and should still find it as a fresh candidate.
- **No `requires:` marker** → assume TS-only (the safe default); a human or a prior agent run can
  add the marker retroactively once a capability gap is discovered (as this issue-sweep run just did
  for several native-parity spin-offs it dispatched with a fully-available Swift+Kotlin toolchain).

#### A capability gap must be PROVEN first-hand THIS run — never inherited (hard rule)

The silent-skip and 🟡 "not verifiable here" dispositions are only sound once you have **actually
established the gap on the machine you are running on now**. A "capability-gap → leave silent" (or
🟡/`needs-human-review`) disposition is **inadmissible without a first-hand probe result from THIS
session** demonstrating the specific gap. The failure this prevents is real: a run declared "no live
environment here" and silently skipped a whole cluster **without probing** — the probe later showed
the live env was reachable over HTTP with valid creds; only the headless browser was blocked. Right
conclusion for part of the cluster, unsound derivation, and it left evidence-comment value on the
floor.

- **Never infer the gap from second-hand sources.** Not the environment banner, not the "cloud
  routine" framing, and — the trap — not *other machines' or prior rounds' comments on the very
  issue you are triaging* ("no CF creds", "can't start daemon", "browser can't reach it"). Those
  describe a **different runtime at a different time**; this fleet is heterogeneous (the whole
  premise of this section). A capability claim copied from a comment is not a capability check.
- **Probe the axis that actually limits the work, not a scalar prior.** Capability is
  high-dimensional: *live-HTTP reachable* ≠ *headless browser reachable*; *some creds present* ≠
  *the specific cred this task needs*; *`gh` binary exists* ≠ *`gh` REST works here*. A blanket
  "cloud sandbox = no live env" is wrong in exactly the details where the decision lives. Run the
  concrete check for the specific capability (`curl` the live endpoint, launch the headless browser
  once, test for the exact cred) before claiming it is absent.
- **Bias toward probing, because a false "can't" is self-concealing.** A false "I can't verify this"
  exits down the sanctioned silent-skip path and leaves **no trace that a judgment was even made**,
  so it is never caught or retried. A false "I can" fails loudly and self-corrects. When you do skip
  for a capability gap, **the probe result IS the required evidence** — cite it, exactly as any other
  disposition must carry its evidence.
- **A gap in one capability is not a pass on all analysis.** Browser-blocked ≠ un-analyzable: many
  "broken UI" issues root-cause cleanly from source + a live *HTTP/diagnostics* read that may be
  reachable even when the browser is not. Prefer a grounded evidence comment over a silent skip
  whenever *any* available first-hand signal grounds a root cause.

This is Phase 1 (the probe script + the marker convention). Wiring automatic skip/claim logic into
Step 1/2's candidate loop, and adopting the same convention in `pr-sweep`, is Phase 2 — not yet done.

### The 🟢 pipeline (one issue at a time, serial)

0. **Verify the issue's PREMISE first — this is a hard stop (a real
   false-premise trap; archetype: `test/sweep-golden/fixtures/535-false-premise-trap.json`).**
   AI-authored spin-off issues carry their own evidence (`grep`/`path:line`)
   and a stated framing ("this is dead code" / "pure placeholder" / "3 lines,
   just delete"). **Re-run the issue's own grep AND broaden it** before
   trusting the framing: search for *who else depends on the thing the issue
   wants to change* (snapshot fixtures, importers, callers, generated refs).
   If reality contradicts the premise, **STOP and downgrade to a comment**
   carrying the counter-evidence + safe options, do NOT execute. A false
   premise turns a "🟢 mechanical" task into a regression. The issue author
   (an agent) did not run the broader grep; you must.
1. **Reproduce first.** Write/locate a test that fails *for the reason the issue states*, run it, capture the real failing output. If you can't make it fail on demand, you can't prove a fix — downgrade to 🟡.
2. **Fix** minimally; prefer backward-compatible (`x ?? legacy`) over a swap.
3. **Verify**: the new test passes, the package's full suite shows **no regression**, `check-types` is clean. Paste the real before/after numbers into the PR. **Isolate pre-existing red from your red:** packages here are often already failing (e.g. afs-ui had 88 CSS-snapshot failures; runtimes/node had a pre-existing `auth/index.ts:151` type error). Before attributing a failure to "pre-existing", *prove* it — either `git stash` your change and re-run (count must be identical) or show it's logically untouchable by your diff (a one-line test-mock edit cannot break CSS snapshots). Then say so explicitly in the PR with the real numbers.
4. **One branch + one PR per issue**, body references the issue (`Part of #N`; use `Fixes #N` only if the PR fully closes it — partial fixes leave the issue open and say which part was handled).
5. **Never auto-merge.** 🟢 means auto-*PR*, not auto-*merge* — the PR still gets its one review, and a human (or pr-sweep's merge rules) decides the merge. "No human intervention" is about the fix work, not the merge decision. This is a categorical, non-negotiable assertion — see `test/sweep-golden/fixtures/1025-forbidden-auto-merge.json` for the forbidden-action regression test.

### White-list, not black-list

Only auto-touch code for explicitly safe categories: TS/pure-function bug with a test, wire-format/field-name mismatch with a conformance spec, a missing-test addition, a doc/type/lint fix, a dependency-already-in-repo polyfill. Anything outside the list defaults to 🟡/🔴. When unsure, downgrade.

**Proven 🟢 patterns and run history:** see this repo's case-law appendix
(repo-profile Case Law References) for the white-list categories that have actually landed (dead not-found
branch → explicit error, empty `catch{}` in test mocks, env-flag cleanup with
a human directive) and the run-by-run track record.

### AI-agent spin-off issues (`<!-- spinoff-of: #N -->`) — the primary autofix target

The bulk of this backlog is **agent-authored spin-off issues**: their body opens with a `<!-- spinoff-of: #N … -->` HTML comment and follows a fixed shape (目标 / 现状证据 with grep / 参考实现 with `path:line` / 具体任务 / 验收标准). They are almost always **0-comment** (no human ever replied) — so they are invisible to the default sweep and only get picked up under `--autofix-green`. **This class is the whole reason `--autofix-green` exists; process it aggressively but within the four checks.**

Per spin-off issue:

1. **Read the `spinoff-of` parent.** The parent (the original doc-audit) often carries the human directive that makes a child green (e.g. a parent issue that had already said "可以彻底清理"). A human "go" on the parent counts as approval for the unambiguous child.
2. **Run premise-verification (🟢 pipeline step 0).** The issue's own grep is necessary but not sufficient — broaden it.
3. **Triage by environment, then by the four checks.** In a TS-only sandbox the realistic green set is: TS/pure-function fixes, test-file fixes, wire-format/conformance mismatches, doc/type/lint, env-flag cleanups. The rest of the standard backlog clusters stay non-green *here*:
   - **Native parity** (`[parity]`, Swift/Kotlin) → 🟡 (can't build/test in TS sandbox; becomes 🟢 only on a full-platform host).
   - **`security` / `P0,security`** → 🔴 always (crypto/vault/ACL/const-time/path-traversal), comment-only even when "obvious".
   - **Multi-phase feature/arch plans** (`feature`, `enhancement` with Phase N) → 不是单 PR,但**也要尝试自动推进,不是冻结**。走 Step 3 feature 行的「评估 → 能起步就 `/agentloop:design-review` → `/agentloop:build-phases`」管道,**一 issue 一条 in-progress 接力线**:每个 hourly run 推进它能推进的 phase(round-aware 续做),撞到真正 human-only fork 才停并给具体待决项。**绝不发「🟠 不在本轮范围 / 留开放」把它冻死**——那一类正是曾经真实出现过『永不被处理』的根因。`design-review`/`build-phases` 本身就是自动流程,feature issue 该用它们跑,而不是甩回给人。
4. **可做即做,不排队 —— `🟢 candidate-queued` 这个 class 删除(它是自锁死循环的根源)。** 一个 issue 判成 🟢(过四关 + **在本环境可验证**)就**当场认领 + 当场做**:cut 确定性分支 `claude/issue-<N>`(Step 4 的认领检查)→ reproduce→fix→test→PR。disposition = **PR 链接**(终态)。
   - **绝不发"🟢 排队中 / 本轮未做 / 留开放 / candidate-queued"这类注释。** 它是**未完成的活穿了终态的衣服**:下一轮轮次感知看到"最后一条是 AI 评论、人没回",就判"已处理、跳过",这条活**永远不做**。用户实测:大量 issue 被这种注释冻死、只剩一堆"我会晚点做"却再不推进。**判得可做,就此刻做完;不要承诺未来。**
   - **本轮容量不够、没轮到的 🟢:不留任何注释**,保持"未处理"——下一轮自然被重新发现、再认领去做。这是**唯一正确的"沉默"**(没有 AI 注释的 🟢 不会被冻结)。
   - **只有真有外部 unlock 条件的才发"终态 disposition + 跳过"**:🟡 not-verifiable-here(本环境建不了/测不了 → draft PR + `needs-human-review`)、🟠 needs-design、🔴 security-human。这些跳到 unlock(换环境 / 人拍板)才合理。
   - 每条 disposition 写清:class + 具体 blocker + unlock 条件。**"silence 是失败模式"只针对你判了『此处做不了 / 要人』却一声不吭的 issue**(那 31 个无注释的就是这类被漏掉的);对『可做但本轮没轮到』的 🟢,沉默反而是对的——**别用一条注释把它冻死**。Group 同理由的(全 native-parity、全 security)一起写,但每个仍各发一条。

### test-sweep 发现的 issue（`test-sweep-failure`/`test-sweep-report` label）— 第二类零人类输入的绿色候选源

`test-sweep` skill(post-deploy 持续 QA)会直接开 issue 记录活部署上发现的问题:`test-sweep-report`
是一轮走查的汇总父 issue,`test-sweep-failure` 是每个失败点各自的子 issue(GitHub 原生
sub-issue,挂在父 issue 下 —— **不是** `<!-- spinoff-of: #N` body-marker 约定)。这类 issue
和上面的 spin-off issue 同属"agent 开的、零人类输入、可能可以自动修"的候选池,但发现机制和
premise-check 的要求都不一样,分开处理:

1. **发现方式:label,不是 marker。** 扫全量 open issue,挑 `test-sweep-failure`(优先,具体到单个
   失败点)或 `test-sweep-report`(汇总父 issue,通常只是索引,较少直接可修)、**零评论**的。
   Step 2 的人机判定对这类 issue 有专门例外(见上「Exception — zero-comment
   test-sweep-failure/test-sweep-report issues」)——不要把它们当人类未处理输入处理,也不要
   因为它们不带 `spinoff-of` marker 就当作"看不见、跳过"。
2. **Premise-check 比 spin-off issue 更重:验证目标是活部署,不是静态代码。** spin-off issue
   的 premise-check 是"重新 grep 广一点";test-sweep 发现的 premise-check 是**重新打一次同一个
   活网站**,确认现象还在——test-sweep 报告的是某次走查时刻的观测,可能已被后续部署修复,也
   可能(如 #2271 自己在建议里提出的)本来就是有意设计、不是回归。**不要只信报告文本就动手改**:
   报告里给的 URL/复现路径,能打就打(如走查报告里附的 raw.githack.com 完整报告链接、复现步骤),
   现象消失 → 直接关闭子 issue(注明"复测已通过,可能已在后续提交修复"),不当 🟢 处理。
3. **判断 disposition 之前先定位是哪一侧错了。** test-sweep 报告的典型形状是 doc-vs-code
   drift(`.man`/`.aup` 声明的行为 vs 实测行为不符)或直接的功能 bug。复测确认现象仍在后:
   - `.man`/`.aup` 文档描述过期、代码行为才是对的 → **doc-update PR**(小改,对应 Step 3 表格
     "asks to update a drifted doc" 那一行的处理方式,只是触发源是 test-sweep 不是人类评论)。
   - 代码相对文档声明的契约回归了 → **bug-fix PR**,走标准 🟢 pipeline(reproduce→fix→test→PR)。
   - 分不清哪侧错、或需要产品判断("这堵登录墙到底该不该在" —— #2271 原话)→ 不是 🟢,降级
     🟡/comment,把两种可能都列出来,不要替产品做主。
4. **白名单同上,不放宽。** 只处理典型 doc-drift 或有清晰 repro 的小 bug;涉及权限/安全边界的
   发现(哪怕看似"只是文档没更新")一律 🔴 comment-only,不因为触发源是自动化就降低门槛。
5. **一 issue 一 PR,`Part of #<test-sweep-failure 号>`。** 若同一父 QA Report 下多个子 issue
   同源同修(如同一个共享组件导致多个 blocklet 同时报告),可以一个 PR 修,但 PR body 里
   逐个列出 `Part of #N` 覆盖到的每个子 issue,不要漏引用。

> Run history (first two `--autofix-green` runs, both TS-only sandbox — proof
> that the pipeline works end-to-end): see this repo's case-law appendix
> (repo-profile Case Law References).
