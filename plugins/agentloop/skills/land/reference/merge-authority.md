# land — why a batch stops for a person

> On-demand reference for [`land`](../SKILL.md) Step 5 merge authority (moved out of SKILL.md in #7105).
> SKILL.md points at the Usage flags; this file holds the mode table and the reason.

**批量默认要确认的理由**：一条指令产生 N 个不可逆的对外动作，这个决定属于用户，不属于 skill。

无人值守（`AskUserQuestion` 被 hook 硬 deny，而显式多引用跳过了 Step 1，所以「不派工」那条不适用）时，跑到「已绿待合」为止就停，把清单落成 comment 并挂 `needs-human-confirm`，不要自己合。要无人值守直合，必须由用户显式给 `--merge=auto`。

## 模式表

| 模式 | 行为 |
|---|---|
| **单件（默认 auto）** | 闸绿 + review 干净 ⇒ 直接合 |
| **批量（默认 confirm）** | 每件到「已绿待合」，列给用户再合 |
| `--merge=auto` | 批量也自动合 |
| `--merge=confirm` | 单件也停下来问 |
| `--merge=never` | 只到绿，不合 |
| **factory run**（`ARC_CODE_AGENT_RUN_ID` 已设） | 不论上面哪种模式，一律只到「已绿待合」，报「ready to merge, human decision」 |

## Factory run：合并权归人（#7662）

factory run 里合并是人的决定：不跑 `<merge_gate_entry>`、不跑 `merge-verified-pr.sh`、不用 `gh pr merge`；
PR 上留好闸证据（`--comment` 的 verification sticky、review verdict、bot-clean），发一条 ready-to-merge 清单
comment、挂 `needs-human-confirm`，报「ready to merge, human decision」，然后结束，不等人合。
`--merge=auto`（不论来自 dispatch 的参数还是 brief）在 run 里**不**授予合并权。

为什么：单件默认 `--merge=auto`，于是一个 land run 合了自己的 PR，另一个只是碰巧因为 `agent:hold` 停下；
事件与决定见 arc#7662。

护栏（不是访问控制）：`merge-verified-pr.sh` 在 `ARC_CODE_AGENT_RUN_ID` 有值时 exit 3 拒绝（在任何 GitHub
调用之前；`--no-gate-record` 也不放行）。exit 3 的意思是「停在已绿待合」，不是「换条路再合」。操作者覆盖：
`ARC_FACTORY_ALLOW_SELF_MERGE=1`，run 自己绝不设。覆盖时脚本先在 PR 正文盖上
`<!-- arc-factory-merge run=<run id> sha=<head> -->`，盖不上就不合，合并记成 agent 合并。
细节见 [headless-factory-run.md](../../../reference/headless-factory-run.md)。
