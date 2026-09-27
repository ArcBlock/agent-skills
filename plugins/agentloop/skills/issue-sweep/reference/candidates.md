# issue-sweep — candidate set, graph step and why windowed scans fail

> On-demand reference for [`issue-sweep`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

## Why a windowed "recently updated" scan is NOT enough

The naive scan — "list issues by `UPDATED_AT` desc, take the top N" — **misses
early human replies that were never re-bumped**. Real misses this caused: one
issue whose only human reply came early and was never re-bumped (archetype:
`test/sweep-golden/fixtures/328-early-human-reply-sank.json`), and another
labeled only `P3` — no `doc-audit`/`bug` — so it wasn't even in the label
union. **Scan by label coverage + the unlabeled catch-all + last-comment,
not by an updated-at window.**

## Step 1 — Build the candidate set (by label, not by recency)

`mcp__github__list_issues` with `state: OPEN`, once per label, union the results.
Candidate labels = the **Label Vocabulary** in `.claude/repo-profile.md`
(Priority + Work-type rows; arc: `doc-audit`, `bug`/`P0`-`P3`,
`enhancement`/`feature`, `research`, `idea`). Case-law: a priority-only label
is exactly how a real issue slipped through; `research`/`idea` issues are
often created unlabeled entirely — Step 3 has the
per-work-type dispatch row for each, and the unlabeled catch-all below closes
the discovery hole by triaging and backfilling the label.

De-dup by issue number. Optional args override this default label list.

**Unlabeled / off-label catch-all(每轮必扫——label 并集对它们天然失明):**
founder/人随手开的 issue 常常 **0 label、0 comment**,actionable 信号全在 body。
真实 miss:一条 feature issue(无 label)、一条 research issue(无 label——创建后
2 小时内 hourly sweep 照常跑了,但 label 扫描永远看不见它,只能靠人手工 `/agentloop:issue-review`
点名)。上面 research/idea 行写的「扫到就补 label」在纯 label 扫描下是**循环依赖**
(没 label 就扫不到,扫不到就没人补 label)——这条 catch-all 通道打破它。**别依赖
人打 label**,每轮追加一次全量 open 列表,把「不带任何候选 label」的捞出来:

```bash
# 一次列全部 open issue,本地滤出没有任何候选 label 的。
# doc-audit-kb(KB/repo-map 基础设施 issue,即 kb_issue)不是工作项,一并排除;
# test-sweep-failure/test-sweep-report 同理排除——它们是 test-sweep skill 自动开的 QA
# 发现,不是「founder 随手开的」catch-all 目标,有自己专属的处理通道(见 Step 3b「test-sweep
# 发现的 issue」),混进这里会被误当人类工作项二次 triage。
# 下一节的 reserved 规则仍然适用——带 agent:hold 的冻结终态动作(人类新评论仍要响应)。
# ★ epic-managed / epic:<n> 必须在 catch-all 的 select 里就排除(Codex P2 on arc#3558):
#   conductor 子 issue 常常只有这两类 label、尚无 work-type label;若不在 jq 里滤掉,
#   下面「对捞出的每条补 label / triage comment」会在 reserved 检查之前就 mutation,
#   与 epic-managed「不 triage、不评论」矛盾。
# -R <repo_slug> from repo-profile.md.
gh issue list -R <repo_slug> --state open --limit 500 --json number,title,labels --jq '
  .[]
  | select(([.labels[].name] | any(. == "epic-managed" or startswith("epic:"))) | not)
  | select(([.labels[].name] | map(select(
    . == "doc-audit" or . == "bug" or . == "P0" or . == "P1" or . == "P2" or . == "P3"
    or . == "enhancement" or . == "feature" or . == "research" or . == "idea"
    or . == "doc-audit-kb" or . == "test-sweep-failure" or . == "test-sweep-report")) | length) == 0)
  | "#\(.number) \(.title)"'
```

> 这条命令稳定捞出两位数条对 label 扫描不可见的 open issue,全是 founder 直开的
> 工作项——系统性缺口,不是单条偶发个案(archetype:
> `test/sweep-golden/fixtures/869-research-no-labels.json`)。

**Before any catch-all mutation:** drop anything that still slipped through with
`epic-managed` (belt-and-suspenders; the jq above is the primary filter). Never
add work-type labels or post triage comments on epic-managed issues.

对捞出的每条:读 title+body 判 work-type(`调研`/`研究`/`[research]` → `research`;
`idea:`/提案语气 → `idea`;带 spec/验收标准 → `feature`;报错/复现步骤 → `bug`),
**先补上对应 label**(可逆 triage,自动做——这样它下轮起进入正常 label 扫描,且
Step 3 的分派行有了正确的 work-type),再并入本轮候选集走 Step 2/3。**判不出类型
的也不静默跳过**:挂 `needs-human-confirm` + 留一条 triage comment 列出你的猜测让
人一键确认——静默跳过 = 这条 issue 对自动化永久不可见,这正是本通道要消灭的状态。

**Then drop the reserved/locked ones (并发协调,见 [`issue-review` ★并发锁](../../issue-review/SKILL.md)):**

- **`agent:hold`** — 人类保留 = **终态冻结,不是处理冻结**("没我反馈别做不可逆动作",不是"别理它")。hold 期间**绝不 close / 绝不代表它做终态处置**,直到人摘掉 label;但**人类新评论照常进 Step 2 候选**——人专门在 hold 的条目上说话,恰是最高优先级输入,必须读并响应(回 comment / 按人类明确要求干活)。无人类新输入的 hold 条目才跳过。可执行闸是 hook `deny-guarded-issue-close.ts`（#5426）；散文不是闸。
- **`agent:processing`(新鲜)** — 正被另一个 run 处理。每候选读它有没有这个 label;有就查锁龄(见下),**TTL 30min 内 → SKIP**(别人在做),**过期 → 不跳**(上一个 runner 崩了,Step 3 会重新 acquire 抢锁)。锁龄取该 label 最后一次 `labeled` 事件时间:
  ```bash
  gh api --paginate repos/{owner}/{repo}/issues/<N>/timeline \
    --jq '[.[]|select(.event=="labeled" and .label.name=="agent:processing")]|last|.created_at'
  ```
  (无 `gh` 时用 `mcp__github__*` 读 timeline。)`agent:processing` 是 advisory——**硬去重仍靠 Step 4 的确定性分支 + 认领检查**;这一步只是早点短路、省掉重复的读/核验/测试。
- **`epic-managed`** — 该 issue 属于一个 **epic-conductor 独占驱动**的 epic(见 [`epic-conductor`](../../epic-conductor/SKILL.md))。**整条排除:不 triage、不认领、不做、不评论。** 这不是 `agent:hold`(冻结终态但仍响应人类评论)——epic 子 issue 由那个 conductor 端到端调度自己的一批 worker 处理,sweep 插手只会撞车、开重复 PR(archetype:#3407 撞 #3395)。`agent:hold` 是「人类保留」,`epic-managed` 是「另一个 agent 保留」;两者都跳过认领,但 `epic-managed` 连人类评论也不由 sweep 代答(那是 conductor 的活)。一条规则管所有现在与未来的 epic。**过滤某个具体 epic 的全部子项**:`gh issue list --label "epic:<父issue#>"`(issue+PR 通用)。
