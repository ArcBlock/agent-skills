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
