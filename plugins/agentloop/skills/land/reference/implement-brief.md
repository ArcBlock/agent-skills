# land — implementer brief (why)

> On-demand reference for [`land`](../SKILL.md) Step 3 (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the rationale and incident history.

## Worktree isolation

**worktree 隔离不是可选项**：当前工作区可能带着与本任务无关的未提交改动，在原地干活会把它们卷进分支。

## Why the traps belong in the brief

你已知的**陷阱**——尤其是**显而易见但错误的修法**——是本 skill 最值钱的一段：你在诊断时排除掉的错误方案，如果不写进 brief，实现者会重新走一遍。

## accept-path, said in full

**accept-path 铁律**：只测「坏输入被拒」等于没测——一个全拒的实现满足所有 reject 断言。

## prior-engines (arc#6184)

身份行由 `agent_identity_script` 生成。**往已有 PR 正文上写时必须带 `--prior-engines <现有 engine: 集合>`**，后来的引擎追加进集合而不是覆盖。arc#6184：覆盖会让另一个 coder 引擎的 reviewer 拿到假 PASS。新开的 PR 没有先前集合，不传该旗。评论身份是本 session，不要把 coder 集合写进评论行。

## Welded run-and-post

开 PR 后立刻 `<verification_entry> --comment <PR#>`——**「跑」和「贴」是焊在一起的**，不能只跑不贴，也不能用 `tsc` / 单项 build 命令代替（同一 SHA 刚跑过，这一步复用证据、不重跑）。

实现阶段**写完先停下来交回**（报告分支 / worktree 路径），不要先跑全量闸——Step 4 的独立 reviewer 要在第一次跑闸之前审。

## Change Set replay

`record-change-set.sh` 把已 push 的 PR head、PR base 和改动文件交给仓库的 ledger 命令：同一个 head 重跑是重放、不开新 round；新的 push 就是新的 head、round + 1。

仓库没有 work ledger 时 profile 写 `none`，脚本会明确打印 not recorded；不在工厂 run 里时由 ledger 命令打印 N/A。**非零退出 = 没记上**，不许 `|| true` 把它吞掉。

## Timeout knob

闸的测试行报 `TIMEOUT` 且 `failed=0` 时，只允许用仓库的超时旋钮（arc：`ARC_VERIFY_TEST_TIMEOUT_MS`，只能调大）重跑**一次**，并在报告里写明取值；`failed>0` 是真红，不许用它洗绿。
