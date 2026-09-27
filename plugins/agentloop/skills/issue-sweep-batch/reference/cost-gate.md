# issue-sweep-batch — 成本闸四问有多硬

> On-demand reference for [`issue-sweep-batch`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

正文里必须贴的 `<!-- cost-gate -->` 段，以及「四问答的是这一簇」的填法，在 SKILL.md Step 5。
这里是三个面各自的真实强度——不要把它们读成一道会替你兜底的闸。

### 这四问今天有多硬 —— 三个面强度不同，不要读成一回事

| 面 | 强度 | 什么时候 |
|---|---|---|
| `bun scripts/issue-cost-gate.ts --body-file <f> --title <t>` | **硬**：缺段落 / 答案不在封闭词表 / 原样复制占位符 → 退出码 3 | 你自己跑的时候 |
| PreToolUse hook `.claude/hooks/record-ungated-factory-issue.ts` | **只建议**：`permissionDecision` 是 `"allow"`，附一条 advisory reason，**不拦**，只留一条 would-have-blocked 样本给规划期的 `--scan` | 无人值守真开单的时候 |
| `lint:issue-cost-gate`（`pnpm lint:arch`） | **硬**，但它管的是**申报表**——这条开单路径有没有被分类过，**不看任何一条 issue 正文** | PR 时 |

⚠️ **所以：无人值守跑到这里，四问缺段落或原样复制占位符并不会被拦住。**
这一段是你自己要守的纪律，不是一道会替你兜底的闸。把它读成「反正过不去」是错的——
声称的强度与实际强度不符，正是这道闸本身要消灭的东西。
