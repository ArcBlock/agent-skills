# 防噪音：上限、全砍全推、正控

规划层最容易出的毛病是自己变成噪音：计划远远跑在执行前面，每周重排一遍却什么都没变，
或者砍了一堆东西没人能说清为什么。下面每一条都是为了防这个。

## 1. 每轮新增上限跟着吞吐量走

```
T        = works[] 里 lastOutput.kind=merged 且 lastOutput.at 在 14 天内的行数 / 14   # <cli_binary> work status --json，不是 portfolio 自报
backlog  = 已 schedule、但 planner 还没开 track 的成员数
lookahead= factory_portfolio_cap 的 lookahead（默认 7d）
C        = <cli_binary> work capacity --json 的 wip.build      # 此刻 fleet 能同时推进的 build track 数（#9240）
N_members= max(0, min(ceil(T × lookahead), 2 × C) − backlog)   # 本轮最多新增多少个可进 build 的成员
N        = min(cap.max_epics, 新计划按名次累加成员数不超过 N_members 的最大计划数)
```

- `T = 0` 且事件源可读：工厂停工了，本轮 `N = 0`，摘要写明「吞吐量为 0，不新增计划」，不当作「没事可做」。
- 事件源读不到：本轮失败退出，不当作 `T = 0`。
- `C` 是容量上的第二道上限：待开 track 的成员最多领先 build 两轮 WIP，机器少了计划就跟着收。
  容量读不到（命令非零退出、`status` 不是 `ok`、`wip` 为空）→ 本轮失败退出，不当作 `C = 0`，也不跳过这道上限。
- 周轮也受同一个上限约束：周轮可以**重排**已有计划，不能借重排一次性塞进大批新计划。
- 截断掉的主题判 `defer`，`wakeOn` 是名次在它前面的计划进入终态（`work-terminal`）；P1 前用指纹 + `after:<下一轮>`，理由里写明真正在等的是「backlog 降下来」。

## 2. 「全砍」和「全推」都要说明

一轮里醒着的条目如果：
- 全部判 `trivial` / `defer` / `duplicate`（全砍），或
- 全部判 `schedule` / `fold`（全推），

摘要必须单独有一节「为什么这一轮是全砍 / 全推」，给出至少一条可核对的理由（比如「本轮醒着的 6 条全是
同一 PR 合并后的残余观察」）。说不出理由，就是判据坏了：本轮仍写出判定，但挂 `attention(kind=stuck)`。

## 3. 砍掉的要能追溯

- 每条 `trivial` / `defer` 写：理由一句、`wakeOn` 至少一个非 `after` 的谓词（求值器会拒绝只有 `after` 的判定），
  `after` 不超过 `max_sleep`；求值器还表达不了的条件（如「人回复」）写进理由，P3 落地后再换成谓词。
- 摘要的「砍掉清单」列出全部被砍条目：issue 号、一句理由、`wakeOn`。人一眼能扫完。
- 建议关闭的 issue 只是建议（R1，`work decide` 提议、approve agent 批准）。目前没有执行入口，批准后由人关；portfolio 自己不关。

## 4. 度量要有正控

| 计数 | 正控 |
|---|---|
| 输入条数 | 只在周轮（全量）做：`works[]` 里 `status=idea` 的行数 = 本轮读到的源 work 数，否则失败（`byState` 把 idea 和 planned 合成了 `queued`，不能拿来对） |
| issue 全文 | 每条都读到了正文；读不到的列名，不静默跳过 |
| 吞吐量 `T` | `counted.mergedEvents` > 0 且 `works[]` 非空，才算测了 |
| 禁区命中 | 至少一个已知该命中的成员（如改 `.claude/**` 的）被标出；一个都没标出时先检查筛法本身 |
| 砍掉的数量 | 和上一轮比；突然归零或翻倍都要在摘要里解释 |

## 5. 判定稳定性

同一条源 work 30 天内 `judgments.portfolio`（dry-run 时比对历次 `roadmap.json`）翻转超过 2 次：判据有缺口，挂 `attention(kind=stuck)`，
`ask` 写「这条为什么反复翻：<列出几次的理由>」。不要靠多判几次求稳定。
