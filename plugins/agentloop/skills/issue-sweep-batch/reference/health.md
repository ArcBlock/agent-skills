# issue-sweep-batch — 工厂健康

> On-demand reference for [`issue-sweep-batch`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

CLI / 页面上的三态词在 SKILL.md。门槛的唯一真相是 `health.ts` 的 `T`；改门槛或 detector 语义时读这里。

## 工厂健康 —— 让人 5 秒钟知道需不需要管

页面顶部与 CLI 首行都是**一个状态 + 至多三条解释**：

```
🔴 ACTION REQUIRED        需要人介入
🟡 DEGRADED               有信号但不需要人介入
🟢 HEALTHY                工厂产出正常，不需要人介入
```

### 分两层，第一层不是 LLM

1. **硬 detector**（`health.ts`）：确定性、便宜、可测。每条给出**证据**，不给结论。
2. **健康判读**（`assess`）：把信号合成一个状态 + ≤3 条解释。

**agent 读 `--json`，不读截图。** 渲染 → 视觉理解 → 推理会再加一层不必要的噪声，
而我们已经在验证信号上吃过噪声的亏。

### 每个 detector 必须有 accept 臂

> **一个从不触发的 detector 与一个健康的工厂完全同色。**

所以 `detectors()` 在健康基线上必须返回**空数组**，`assess()` 必须**能说
healthy 且 humanAttention=false**——只会说黄/红的系统等于没有系统，
它会退化成另一个骚扰人的 micro-manager。这两条在测试里钉死了。

### 单信号不足以判定

`backlog-expansion` 要求**进出比高**且**存量在涨**同时成立。只看比值会在
「正在恢复」时误报——arc 实况正是比值仍高但净值开始转负。

### 斜率必须算自无偏输入

**不要**把 `stockSeries` 直接喂进 detector：它由「当前 open + 窗口内已关闭」推出，
更早关闭的项不在窗口内，曲线左端**系统性偏低**。用 `netToCumulative(每日净值)`——
开与关同源同窗口，作差后偏差抵消。

### 当前门槛（集中在 `health.ts` 的 `T`）

| detector | 条件 |
|---|---|
| `backlog-expansion` | 7d 进出比 > 1.25 **且** 存量斜率 > 1/天 |
| `classification-debt` | untyped ≥ 15%（warn）/ ≥ 25%（bad） |
| `stale-work` | >7d 的占 open ≥ 40% |
| `undiagnosed-symptom` | 超过 TTL（7d）仍无判决的 symptom ≥ 2 条（warn）/ 且占 open symptom ≥ 50%（bad） |

`undiagnosed-symptom` 的 TTL **标定自实测**：arc 上已判决关闭的 `test-sweep-failure`
全部在 **0–5 天**内关闭（抽样 20 条，最长 5 天，中位约 2 天），7 天落在观测分布之外。
它测的是相对这个工厂**自己的**基线的偏离，不是一个从外面拍下来的数字
（oversight-discipline 的「基线偏离优于固定阈值」）。它也**不是** `stale-work` 的重复：
后者看笼统的年龄，一条 20 天的 feature 和一条 8 天未判决的 symptom 在它眼里一样。

正控：健康基线 fixture 里**必须**含一条 TTL 内的 open symptom，否则这个 detector 的
accept 臂是空的——「仪器看过了、没事」与「压根没东西可看」同色。
