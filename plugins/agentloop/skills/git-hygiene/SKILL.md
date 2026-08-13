---
name: git-hygiene
description: >
  After a merge or when ending multi-branch work: switch the primary checkout
  to the default branch, fast-forward from origin, then remove local worktrees
  and branches that have no unique work left. Use when the user says "切回
  main 清理", "清理 worktree", "prune branches", "git hygiene", "收工清分支",
  or after confirming a PR merged. Safe by default: never delete a branch or
  worktree that still has commits not on origin/<default> unless squash-merge
  parity is verified. On explicit request ("这些是不是该补 PR"), also does a
  provenance investigation on each KEPT branch — merged-elsewhere / superseded
  / actively-tracked-via-open-PR / genuinely-orphaned — with a content-level
  redundancy check (not just commit-count) before rebasing and opening a
  belated PR for anything confirmed still-unique. Works in any git repo.
---

# git-hygiene

收工 / 合并后的本地 Git 卫生：**回默认分支 → 拉最新 → 只清确认无独特工作的 worktree 与本地分支**。

与现有 skill 的分工：

| Skill | 做什么 |
| --- | --- |
| **git-hygiene（本 skill）** | 回 `main`、ff-only pull、按「相对 origin/main 是否还有独有提交」清 worktree/分支 |
| `git-worktree`（compound-engineering） | 创建 / 切换 / 交互式清理 **`.worktrees/` 约定** 下的并行 worktree |
| `blocklet-branch` | 按 blocklet 仓库约定**开**迭代分支 |

本 skill **不**替你 merge PR、不 force-push、不 `git clean -fdx`、不丢 dirty 改动。

## 触发

- 「切到 main / 拉最新 / 清理没用的 worktree 和 branch」
- 「确认没有未合并工作再删」
- PR 已 merge 后的本地收尾
- 多 agent 并行结束后的主工作区复位
- 「这些 KEEP 的分支是不是该补 PR / 帮我看看最新改动是什么时候 / 仔细核对没合入的话都发 PR」
  → 触发 §4.5-4.7 深挖流程（默认 §3-6 主流程不做这一层，太贵；只在用户明确要求时才逐条调查）

## 默认假设

- 远程名：`origin`
- 默认分支：优先 `origin/HEAD` → 否则 `main` → 否则 `master`
- **删除闸门 = 内容已在 `origin/<default>` 上**，不是「我记得 merge 了」

## 硬规则

1. **主工作区 dirty → 停。** 有 uncommitted 改动时不 `checkout`、不删分支。先让用户 commit / stash / 明确丢弃。
2. **只 `git pull --ff-only`。** 拒绝非快进；有分叉就报告，不 rebase/merge 擅自修。
3. **不删仍有独有提交的分支。**  
   `git merge-base --is-ancestor <branch> origin/<default>` 为假 → **KEEP**，除非走 squash 校验（见下）。
4. **不删 dirty / locked worktree。**
5. **不删当前检出分支**（先切到 default）。
6. **主 worktree 永不 `worktree remove`。**
7. **远程 `origin/<branch>` 已 gone ≠ 本地可删。** gone 只说明远端没了；本地 tip 仍可能有未合入提交。
8. **一次审批只管这一次。** 用户说「继续清」时仍对 KEEP 列表逐类处理，不默认 `branch -D` 全部 unmerged。

## 流程

### 0. 范围

- 默认：当前 repo（`git rev-parse --show-toplevel`）
- 用户点名多个 repo（如 site + arc）：**每个 repo 单独跑完整流程**，报告分开写

优先跑确定性脚本（inventory；可选 apply）。脚本在 skill 旁：

```bash
# From agentloop plugin install (team):
ROOT="${AGENTLOOP_ROOT:-$HOME/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop}"
# Or when developing in arc SoT:
# ROOT="$(git rev-parse --show-toplevel)/.claude/plugins/agentloop"

bash "$ROOT/skills/git-hygiene/scripts/git-hygiene.sh" inventory
# 审查报告后：
bash "$ROOT/skills/git-hygiene/scripts/git-hygiene.sh" apply --yes
# 多 repo：
bash "$ROOT/skills/git-hygiene/scripts/git-hygiene.sh" inventory /path/to/other-repo
```

Agent 必须读脚本输出再决策；**apply 只处理 SAFE 类**。SQUASH_CANDIDATE / KEEP 由 agent 按下面规则处理。

### 1. 库存（只读）

收集并展示：

| 项 | 命令要点 |
| --- | --- |
| 当前分支 / dirty | `status -sb` |
| 默认分支 | `origin/HEAD` 或 main/master |
| fetch | `git fetch origin --prune` |
| worktree 表 | path · branch · dirty 行数 · locked? |
| merged 本地分支 | `git branch --merged origin/<default>` |
| unmerged 本地分支 | `git branch --no-merged origin/<default>` |
| 当前 feature 相对 default | `git log --oneline origin/<default>..<branch>` |

### 2. 回默认分支

1. Dirty → **停**，列出改动，问用户  
2. `git checkout <default>`  
3. `git pull --ff-only origin <default>`  
4. 确认 `status -sb` 为 `## <default>...origin/<default>` 且无 ahead/behind（或仅说明已对齐）

### 3. 分类每个本地分支 / worktree

对每个非 default 本地分支（及绑定它的 worktree）：

| 类 | 条件 | 动作 |
| --- | --- | --- |
| **SAFE** | tip 是 `origin/<default>` 的祖先；worktree 非 dirty、非 locked | 可删 worktree → 再 `branch -d` |
| **SQUASH_CANDIDATE** | 非祖先，但关联 PR 已 MERGED（`gh pr view` / 合并提交信息），或用户声称已 merge | **必须做内容校验**（见 §4）通过后才可 `-D` |
| **KEEP** | 有独有 commit；或 dirty；或 locked；或无法证明已在 default 上 | **保留**，报告 commits ahead；用户要求「这些是不是该补 PR」时走 §4.5 深挖 |
| **DETACHED_TMP** | worktree 为 detached HEAD，且位于 `/tmp`、`/private/tmp`、明确的 review 沙箱路径 | 非 dirty 则可 `worktree remove`；无对应需保留分支 |

### 4. Squash /  rebase 合入的校验（SQUASH_CANDIDATE）

`branch --merged` 对 squash **会漏报**。删除前至少满足其一：

**A. PR 证据（优先）**

```bash
gh pr list --state merged --head "<branch>" --json number,mergeCommit,url
# 或
gh pr view <n> --json state,mergedAt,mergeCommit
```

`state=MERGED` 后仍建议 B。

**B. 路径/树证据（必做当有疑虑）**

1. 列出分支相对 merge-base 改过的路径：  
   `git diff --name-only origin/<default>...<branch>`
2. 对**任务相关**路径（或全部若集合小）：确认 `origin/<default>` 上存在且与分支 tip **无关键内容缺口**  
   - 简单：`git diff origin/<default> <branch> -- <paths>` 为空或仅 default 更新  
   - 或：分支独有路径在 default 上已存在且内容可接受
3. **禁止**仅因「PR 标题像」或「issue 关了」就 `-D`

校验失败 → 标 **KEEP**，写明缺什么证据。

**效率提示（分支数量多时）**：不要对每个分支单独 `gh pr view`。先一次性拉全量：
`gh pr list --state merged --limit 500 --json headRefName,number,mergeCommit,mergedAt`，
本地用 `headRefName` 做字典匹配。N 个分支的 §4.A 查证从 N 次网络调用降到 1 次。

**`diff --stat` 噪音陷阱（KEEP / SQUASH 判断都会踩）**：对一个很久没 rebase 的旧分支跑
`git diff origin/<default> <branch> --stat`，输出会被**整个仓库这期间的无关漂移**淹没
（几百个文件、几万行，全是别的 PR 带来的噪音），完全看不出这个分支自己的改动是什么。
**正确做法**：先 `git log origin/<default>..<branch> --oneline` 找出分支自己独有的 commit，
再对**这些 commit 各自**跑 `git show --stat <sha>`（不是分支整体 diff）看它们各自动了哪些
文件——这才是这个分支的真实改动面。診断 KEEP 的产权时（见 §4.5）一律用这个方法，不要被
`--stat` 的大数字吓退或误判「这分支改了半个仓库」。

### 4.5 深挖 KEEP：这条分支该补 PR、已经 superseded、还是已经有人在跟？（用户要求时才做，非默认）

§3 把「有独有 commit 且证不了已在 default 上」的分支统统扔进 KEEP 就停了——**这是安全默认，
不是终局判断**。用户问「这些看起来是正经任务，是不是该补 PR」时，对每条 KEEP 分支走这个决策树，
不要一上来就假设「没 PR = 该补 PR」：

```
对每条 KEEP 分支:
  1. gh pr list --head <branch> --state all --json number,title,state,mergedAt,headRefOid
  2. 按结果分支:

     PR 是 MERGED
       → 比对 PR 的真实 headRefOid 与本地分支 tip：
         - 相同或本地是其祖先 → 本地无独有价值，安全删（内容已进 default，只是本地分支
           对象本身没跟着更新）
         - 本地 tip 领先于已合并的 PR head → 极少见但要处理：这些多出来的 commit 是
           PR 合并*之后*才加的，按「从未有 PR」路径（步骤 4）单独复核这几条 commit

     PR 是 CLOSED（非 merged）
       → 同名/同主题功能可能已经用**另一个分支**落地。核实手法：
         `git log --oneline origin/<default> | grep -i "<PR 标题关键词>"`
         或直接读 PR 标题描述的文件/功能是否已存在于 default。
         确认后 = SUPERSEDED，删本地分支，报告里写清楚是被哪个 PR/commit 取代的
         （不要只因为「PR 关了」就假设 superseded——必须找到真正承接内容的那个 commit）

     PR 是 OPEN
       → **这条分支不是孤儿，是有人在管的活工作**。核实 `headRefOid` 是否等于本地 tip：
         - 相等 → 本地就是那条 PR 分支的镜像，正常
         - 不等 → 本地落后于远程 PR 真实状态（远程已经被继续推进），本地副本没有独有价值
         本地一律**不需要**开新 PR（已经有一条在跟踪），也不要去改/推那条远程 PR 分支
         （不知道谁在负责、可能撞车）。只报告状态 + 链接，交给已经在跑的流程处理。

     从未有任何 PR（gh pr list 返回空）
       → 进入「补 PR 候选」判定，见下方 §4.6。绝不能只因为「没 PR」就假设是遗忘的好东西——
         多数情况下没 PR 是因为内容早已用别的方式（甚至手工）落进 default 了，见 §4.6 的
         冗余检测。
```

### 4.6 补 PR 前的冗余检测（KEEP → 从未有 PR 时必做）

**核心风险**：把「本地分支比 default 多几个 commit」直接当成「这是没提交的好工作」——这是
错的假设。分支旧了以后，它改的内容常常已经用别的路径（另一个分支、手工改、别的 PR 顺带改）
进了 default，只是这条分支自己没被更新/删除。**补 PR 前必须证明内容还没在 default 上**，
不能只凭「有独有 commit」这个信号。

1. 用 §4「`diff --stat` 噪音陷阱」的方法，从分支独有 commit 里找出它**真正改了哪些文件**
   （不是整条分支 diff 出来的几百个文件）。
2. 对每个文件做**内容级**冗余检测，不是路径级：
   ```bash
   diff <(git show origin/<default>:<path>) <branch-or-worktree-working-copy>/<path>
   ```
   - 完全相同 → 这个文件的改动**已经在 default 上**（大概率是别的分支/手工改带进去的），
     标记冗余
   - 不同 → 看 diff 内容是不是这条分支自己要做的那件事，还是分支只是**落后**于 default
     后来的无关改动（这种情况下 diff 会显示 default 有、分支没有的新内容——这是分支
     「过时」不是分支「领先」，同样不算需要补交的独有价值）
3. **同一逻辑适用于 dirty worktree 里的未提交改动**——不要因为 `git status` 显示 dirty
   就默认那是有价值的在途工作。同样对每个 dirty 文件做步骤 2 的内容级比对：如果 working
   copy 的内容跟 default 上的版本一致，这只是「凑巧手工重复了一遍已经合并的改动」，不是
   独立工作，直接可以丢弃（走正常 dirty 处理：先给用户看一眼再丢，不要在没确认前 `git
   checkout --` / `git clean` 掉）。
4. **反常 dirty 信号，先怀疑损坏不是编辑**：如果一个 worktree 显示成百上千个文件被标记为
   工作区删除（尤其是仓库根级文件如 `LICENSE.md`/`CHANGELOG.md`、或整个不相关目录如
   `platforms/`/`codereview/` 之类跟当前任务八竿子打不着的路径也在删除列表里），这**不是
   真实编辑**，是这个 worktree 目录被外部进程/沙箱/别的工具清空或挪用过。不要逐文件分析
   这类 dirty——识别出这个模式后直接报告「疑似目录损坏，非真实改动」，如果分支本身内容已
   确认在别处合并（走了 4.5 的 MERGED 路径），可以在用户确认后 `worktree remove --force`；
   如果分支内容还没确认过，先按正常 KEEP 流程走，不要因为「dirty 所以可能重要」而投入
   大量时间去 diff 几千个文件。
5. 冗余检测全部通过、确认是真实独有内容 → 才进 §4.7 提交补 PR。

### 4.7 提交补 PR（§4.6 确认内容真实独有后）

1. **rebase 不 merge**：`git rebase origin/<default> <branch>`（或先 `git branch
   <branch>-pr <branch>` 复制一份再 rebase，保留原分支名不动，避免和历史上可能存在的
   同名 PR 记录混淆）。冲突 → 停，报告冲突文件，不擅自二选一。
2. 干净 rebase 后跑验证：按仓库自己的 verification 入口（如有 `--na "docs-only
   change"` 之类的豁免机制，纯文档改动可以用；否则跑真实验证门禁）。
3. push 新分支，开 PR。**PR body 必须显式说明这是「补交」**——写清楚：为什么这条工作
   之前没走 PR（如果知道原因）、内容是否仍然准确/未过时（关联 issue/epic 当前状态如何，
   有没有验证过没被后续变化淘汰）、身份行按仓库约定生成。不要让 reviewer 以为这是一个
   全新的、临时起意的改动。
4. 补 PR 开出后，删掉本地旧分支（内容已经在新 PR 分支上，旧分支名不再需要保留）。

### 5. 执行删除（仅 SAFE + 已校验 SQUASH）

顺序固定：

1. `git worktree remove [--force 仅当用户确认且非 dirty 误报]` `<path>`  
2. `git branch -d <branch>`；squash 已校验可用 `-D`  
3. `git worktree prune`

绝不：

- `git push origin --delete`（除非用户明确要求清远程）
- `git clean -fdx` / 删未跟踪构建产物（除非用户明确要求）
- 删 `main` / default / 当前分支

### 6. 报告模板

```markdown
## git-hygiene · <repo path>

**default**: `<branch>` @ `<shortsha>` (= origin/…)
**working tree**: clean | dirty (… )

### Removed
- worktrees: …
- branches: … (SAFE / SQUASH#<pr>)

### Kept (still have unique work or risk)
| ref | ahead of origin/<default> | reason |
|-----|---------------------------|--------|
| … | N commits / dirty / locked | … |

### Not done
- …
```

走了 §4.5/4.6/4.7 深挖时，在 Kept 表格后加一节，逐条给出产权判定结论（不要只写「kept」）：

```markdown
### KEEP 深挖结论
| ref | 判定 | 证据 | 动作 |
|-----|------|------|------|
| … | SUPERSEDED（被 #123 取代）/ ACTIVELY-TRACKED（open PR #456）/ 已补交（PR #789）/ 冗余已丢弃 / 仍不确定 | … | 已删 / 已开 PR / 留给用户 |
```

多 repo 时每个 repo 一节。

## 可选：远程 gone 的本地分支

`git fetch --prune` 后 tracking 显示 `gone`：

- 仍先按 §3 分类  
- gone + SAFE（已是 default 祖先）→ 可删  
- gone + 有独有 commit → **KEEP**（可能是未推完或 squash 未校验）

不要写「gone 就全删」的脚本逻辑。

## 与 wrap-up 的关系

- **wrap-up**：session 回顾、文档/profile 同步  
- **git-hygiene**：本地 Git 图复位  

可同一会话串联：先 hygiene 再 wrap-up，或相反；互不替代。

## 不做什么

- 不整理 stash 列表（除非用户要求）
- 不关闭 GitHub PR / issue
- 不升级依赖、不跑全量测试门禁（除非用户要求验证 main 可构建）
- 不把「分支名像 agent 临时」当成可删充分条件
