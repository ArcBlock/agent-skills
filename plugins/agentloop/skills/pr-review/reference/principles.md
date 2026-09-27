# pr-review — key principles and sweep-trace detail

> On-demand reference for [`pr-review`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

## Key Principles

1. **对照已落地代码是第一优先,核验范围含横切影响。** PR diff 自洽 ≠ 落到现实正确。最有价值的发现是"这个 fix 没真修 / 这条 doc 改动对不上 shipped 面 / 这个 test 是空跑"。**并且**:diff 自洽也 ≠ 对系统其余部分无害——必跳出 diff 查六件横切影响(Step 2.5):反向引用(删/rename 留下的悬空引用)、跨包 parity(node/cf 镜像 + 声明↔分派配套)、端到端使用场景闭环(不只看有没有 caller)、性能回退(含请求链·init·冷启)、测试覆盖、清理收尾。**这是 agent review 最常漏的一层。**
2. **verification 门控是信号不是判官(PR 上已无 CI)。** 失败必诊断根因(a/b/c/d/e),PASS 也不免逐条核验。reviewer 读事实、不跑闸。单行 lint 等机械件可自修(攒进同一批修复);真实测试/类型/架构/**格式**违规 BLOCK(arc#5805:format 已是 blocking);不是本 PR 造成的红仍然挡合并,只能二分根治或 `--blocked-by` 由闸判定,不盲目重跑、不调超时洗绿。
3. **冲突要定责到留谁关谁,带判据。** 同 issue / 同文件两把主键;矛盾(如 license 串不一致)必须查权威源拍板,不能两个都留。
4. **每条发现都有可复现证据。** `path:line` / `gh` 输出 / 真实测试输出。无证据 = 不写。
5. **产物落 PR,不落会话。** 跑完 = PR 里多一条可被下一轮接力的 verdict comment。
6. **引擎只判不合。** merge/close 的不可逆动作留给 pr-sweep 的受闸 ladder + 人的边界。
7. **要人介入时,给可照跑的验证,不给笼统"请确认"。** escalation verdict 必带「需人确认块」(Step 5.5):要你判什么 + agent 已核验什么(免重做) + **怎么验(可还原成命令就给命令 + path:line + 预期,security 逐条列;还原不了的判断题给选项+判据+推荐,绝不造假命令)** + 定了之后各分支解锁动作。拍板块两要素硬性检查:**问题+建议回答、选择+区别+推荐——两个都给不出 = 发现真正的问题,显式升级,不许拿"请人工确认"糊过去**。
8. **一 PR 一 verdict,以 sha 为界。** verdict comment 全 PR 唯一(marker upsert,跨 runner 也刷同一条);sweep-trace 的 `sha` 是新鲜度机器键——fresh 就跳过(零产出是正确产出),stale 就增量复审。三个 agent 各自 full review、评论堆成六条、没一条对当前 HEAD 有效(#1812)是本条规则要根除的形态。
9. **Bot P1/High 未 addressed 不得 MERGE。** 清单在 Step 0.4;等/回/推进在 [the shared receipt protocol](../../../reference/review-receipt-protocol.md)。本 skill 只判合不合,不合。

## ★ sweep-trace 埋点（L2 可观测层）

每条本 skill 发出的 AI verdict comment 末尾**必须**附一行 sweep-trace HTML 注释（人不可见、grep 可查、L1 eval 复用为 golden baseline 数据来源）：

```html
<!-- sweep-trace: {"ver":1,"pr":N,"gate":"verdict","val":"<val>","sha":"<head-oid>","round":<n>,"run":"<ISO8601>"} -->
```

字段：
- `ver`：schema 版本，当前 `1`
- `pr`：对应 PR 编号（数字）
- `gate`：固定值 `verdict`
- `val`：决策值，取 pr-review 受控词表（5 类）：`MERGE` / `COMMENT` / `SUPERSEDE` / `BLOCK` / `CLOSE`
- `sha`：本 verdict 针对的 PR HEAD（40 位 commit oid，`gh pr view <n> --json headRefOid`）——Step 0.6 跨 runner 去重/新鲜度判定的**机器键**。旧 trace 无此字段 → 一律视为 stale
- `round`：这是**这个 PR 已经发生过的第几轮 review**。派生规则：
  **这一轮真的重新核验了 ⇒ 上一条 trace 的 `round` + 1；否则照抄。**
  读不到上一条 trace、或旧格式无 `round` ⇒ 本轮是 `1`。**不猜、不从记忆里写。**

  按上面那张新鲜度表逐格对齐（**判据是「有没有重新核验」，不是「sha 变没变」**）：

  | 新鲜度 | `round` |
  |---|---|
  | **fresh**（跳过 / 只并入证据） | 照抄 |
  | **fresh + 人类新评论**（针对性处理，不重跑核验） | 照抄 |
  | **★ 视同 fresh（机械重生成）** | **照抄——绝不 +1** |
  | **stale**（增量复审） | **+1** |
  | **stale 但结论不变、已升级等人**（仍做了增量复审） | **+1** |
  | **无 verdict**（首轮） | `1` |

  > **轮次记的是审查劳动，不是 commit 事件。** 一个 release-please 型 PR 的 sha 每次上游
  > 合入都会变，按 sha 记就会三次 churn 烧光 `land` 的 3 轮预算，而一次 review 都没发生。
  >
  > verdict comment 是**每 PR 唯一、原地 upsert** 的（#1812），所以「审了 1 轮」和
  > 「审了 5 轮」在 PR 上看起来完全一样——轮次落在 trace 里，下一轮才**解析得到**它，
  > 而不是靠记忆（记忆跨 subagent / session / runner 都不存在）。
  > 同 local-review 的 `<!-- local-review-state {"round":N} -->`。
  > 消费方：`land` 的 review 轮次上限（Step 4）。
- `run`：UTC 时间，`new Date().toISOString()` 格式

**trace 只附在发出的 verdict comment 末尾；read-only 模式（无 `--post`）不发 comment，不附 trace。**
