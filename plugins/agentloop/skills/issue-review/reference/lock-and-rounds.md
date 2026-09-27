# issue-review — concurrency lock and round-awareness

> On-demand reference for [`issue-review`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

## ★ 并发锁(每次 run 先 acquire,收尾必 release)

多个 actor 会同时碰同一个 issue:定时 `issue-sweep`(cron)、多人本地手工 `/agentloop:issue-review`、本地 agent。不协调就**重复读+核验+跑测试+重复评论**(白烧 token),严重时重复开 PR。两个 label 各管一件事:

| label | 含义 | 谁加/摘 | 谁尊重 |
|---|---|---|---|
| **`agent:hold`** | **人类保留 = 终态冻结**——"没我反馈别做不可逆动作(close/merge)",**不是"别理它"**(**issue/PR 通用**) | **只人加、只人摘**;agent 永不自动摘。**唯一例外(arc#2914)**:本 skill 产出「建议关闭」类结论清单时,**自动加**给清单点名的 issue(见下 ★「建议关闭」类结论清单)——**摘除仍然只人**。 | **`issue-sweep` / `pr-sweep` 冻结终态动作**(永不 close/去重关闭/合并),但**人类新评论/新 commit 照常触发 review + 响应**(人的反馈是最高优先级输入);无新输入才跳过。**`issue-review` / `pr-review` 显式手工调用只提示不挡**(人点名就是要处理) |
| **`agent:processing`** | **处理中互斥锁**(advisory,带 TTL 30min) | agent 开工 acquire、收尾 release | 任何 run 见**新鲜**的锁就 **SKIP**;**过期**(上一个 runner 崩了)则抢锁重做 |

关闭带 `agent:hold` / `needs-human-confirm` 的 issue，可执行闸是 hook `deny-guarded-issue-close.ts`（#5426）；散文不是闸。

> **跨 issue/PR 边界:** `agent:hold` 两边通用——「人类保留」是与对象类型无关的预约(GitHub label 仓库级共享),两侧语义一致:**冻结终态动作(close/merge),不冻结响应**——人类新评论照常处理,`pr-review` 显式调用只提示不挡(见各自 SKILL)。`agent:processing`(TTL 互斥锁)**只用于 issue**:PR 侧的并发去重由 `pr-sweep` 自己的确定性分支 `claude/issue-<N>` + 开 PR 前认领检查 + disposition label 承载,不复用这个锁。

**定位要诚实:`agent:processing` 是 advisory(省重复工作),不是完美分布式锁**——本仓库人和 AI 同账号/可能同 token,label-add 幂等,两机同瞬起步有残留竞态。**真正的硬去重仍是 `issue-sweep` 已有的「确定性分支 `claude/issue-<N>` + 开 PR 前认领检查」**,这层不动、兜底。`agent:processing` 只是把撞车从"收尾才发现"提前到"开工就短路",省掉前面的读/核验/测试。

**无分支兜底的终态动作(comment+close 类,如 ★父级 rollup)另有硬互斥:claim-comment fencing。** 分支碰撞兜不住它们,label 又无 CAS——用 [`issue-graph`](../../issue-graph/SKILL.md) 的 `claim.ts`(comment id 全序裁决,先写后读、最早未过期 claim 赢):

```bash
bun <plugin_root>/skills/issue-graph/scripts/claim.ts --issue <N> --action rollup   # exit 0=赢/3=输(输了自删claim退出)
# …执行动作(动手前最后重读一次目标状态)…
bun <plugin_root>/skills/issue-graph/scripts/claim.ts --release <claimId>           # 完成必调;崩溃靠TTL 30min兜底
```

> **命名消歧**:本 skill 里 `in-progress` 这个**词**已是「多轮续做的 comment disposition」(轮次感知接力),所以互斥锁**另起名 `agent:processing`**,别复用 `in-progress`。

**acquire(Step 0 最前,读 thread 之前):**

```bash
N=<issue>; TTL_MIN=30
# 缺 label 自建(幂等,best-effort)
gh label create agent:hold       --color D4C5F9 --description "人类保留:自动化别碰,只人摘" 2>/dev/null || true
gh label create agent:processing --color FBCA04 --description "处理中互斥锁(advisory,TTL 30min)" 2>/dev/null || true

labels=$(gh issue view "$N" --json labels --jq '.labels[].name')
# agent:hold —— 人类保留:显式手工调用只提示(sweep 才真跳过)
grep -qx 'agent:hold' <<<"$labels" && echo "⚠️ #$N 带 agent:hold(人类保留);显式调用继续。"
# agent:processing —— 互斥锁:新鲜则 SKIP,过期则抢
if grep -qx 'agent:processing' <<<"$labels"; then
  since=$(gh api --paginate repos/{owner}/{repo}/issues/$N/timeline \
    --jq '[.[]|select(.event=="labeled" and .label.name=="agent:processing")]|last|.created_at')
  now=$(date -u +%s)
  then=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$since" +%s 2>/dev/null || date -u -d "$since" +%s)
  age_min=$(( (now - then) / 60 ))
  if [ "${age_min:-9999}" -lt "$TTL_MIN" ]; then
    echo "🔒 #$N 正被处理中(since $since, ${age_min}min<${TTL_MIN}) — SKIP"; exit 0
  fi
  echo "♻️ #$N 锁已过期(${age_min}min) — 抢锁重做"
fi
gh issue edit "$N" --add-label agent:processing      # 加锁
```

**release(收尾,成功/失败都做):**

```bash
gh issue edit "$N" --remove-label agent:processing
```

- **`--dry-run` 不 acquire/不 release**(不做任何 outward 写);只在发现已上锁时打印一句提示。
- **★ 解读→执行的升级点 = 重新过 Step 0。** 会话以「帮我看看/解释一下」开场(dry-run 语义,不加锁)后,用户中途说「解决掉/实现它」——**升级为执行的那一刻必须先 acquire 锁再动手**,不能带着 dry-run 的无锁状态直接开工(实战教训:曾因此被并发 agent 重复实现)。
- **长任务续锁**:预计超过 TTL(30min)的执行(实现+验证+PR),每 ~20min 重新 `gh issue edit <n> --add-label agent:processing` 一次(label-add 幂等,timeline 会刷新 labeled 时间戳),否则锁中途过期照样被抢。
- **崩溃/被 kill 没 release** → 锁靠 TTL(30min)自动失效,下一个 run 抢锁重做,不会永久卡死。
- **手工想长期独占**某条:人**先打 `agent:hold`**(sweep 永久绕开),处理完人摘掉——比临时锁更强、更明确的预约。

## ★ 轮次感知 + 省 token(每次调用先做这件事)

**不要无脑全量重跑。** 一篇 issue 会被处理多轮;后续轮的成本应该远低于首轮。先读 thread(`gh issue view <n> --comments`,便宜),判断轮次:

| 轮次 | 信号 | 该做什么 |
|---|---|---|
| **首轮(冷启动)** | 没有既往 AI review/audit comment | **先 triage 价值,按档投入**(见下):明显废弃的只轻确认;真活的才全量(对照代码 + 跑测试) |
| **后续轮(热启动)** | 已有 AI 结论 + human 意见 | **不重做**:读 thread,把既往证据当既成事实,按 human 意见走下一步 |

**冷启动也要按价值分档,别一上来就 full build / 全测:**

- **先廉价判类别**:读 frontmatter(`superseded` / `superseded_by` / `deprecated`)+ `ls`/`grep` 扫一眼对应代码在不在。**明显已废弃 / 不再有价值**的(显式 superseded、方案被取代、对应代码已移除)→ 只做**轻确认**:用 `grep`/`ls`/`git log` 坐实"代码确实没了 / 已被取代"即可下 `deprecated`,**不 build、不跑测试套件、不逐条 `path:line`**。
- **只有判断它「真活着」**(可能 drifted/partial/current、细节要紧)时,才上全量:逐条 `path:line` + 真跑测试。
- 一句话:**投入与文档的价值成正比。** 给一篇要删的死文档做全量审计,本身就是浪费。

> ⚠️ **以上「按价值分档 / 轻确认 / 省 token」只约束 doc-review 和 doc-audit。System-audit 不走这套**——见下。
