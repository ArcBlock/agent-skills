# issue-review — parent rollup (authorized auto-close)

> On-demand reference for [`issue-review`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

## ★ 父级 rollup(孩子全关的父 issue 收尾)——授权的自动 close 例外

触发:`issue-sweep` Step 0.5 的 `graph-scan` 报出 `rollupCandidates`(open 父 issue
∧ 原生 sub-issue 全部已关),或人点名。**这是本 skill「绝不自动 close」铁律的唯一
显式例外,需 repo owner 授权**——修的是「孩子
全做完、父 issue 敞着等人 bump」的存量病。close 可逆(可 reopen),风险等级是噪音不是损坏。

**流程(顺序硬性):**

1. **幂等检查**:issue 已关 → 结束;已有 `<!-- rollup-done -->` marker comment → 结束。
2. **fencing 抢锁**:`claim.ts --issue <N> --action rollup`(见 ★并发锁)。输了 → 结束
   (另一台机器在做)。`agent:hold` 的父 issue **不做 rollup close**(hold = 人类保留
   终态,见并发锁表),只写综合 comment 不关。
3. **核对验收**:读父 issue 的验收标准/问题清单/body 意图,逐条对应到子 issue/PR 的
   落地证据(`path:line`、PR 链接、测试输出)。**动手前最后重读一次 issue state**
   (已关/有新人类 comment → 放弃动作,先按新输入走)。
   **★ 大块 issue 的完整测试闸(Robert 拍板 2026-07-20,源 #1947)**:多 phase /
   带 sub-issue 图 / 带终局验收的 feature epic,**close 前必须有真实 surface 上的
   完整端到端场景测试**——不是各 PR 单测绿,而是在真实目标环境(真机 / 真浏览器 /
   live daemon)设计多类型场景(正向 + 诚实性负样本 + 边界),逐 case 跑、每 case 附
   截图/输出证据,报告以稳定编号 checkbox(如 FM-01…)post 到 issue 逐项核销;
   **测试计划本身先 post 并标注为关闭验收条款**。缺这层 → 不 close,先补测试
   (这是 rollup 的默认组成,不等人提醒)。失败项如实记录:接线 bug → spin-off;
   平台/模型局限 → 注明请人认可,不调宽判定凑绿。单 PR 小修不适用本闸。
4. **综合 comment**(中文,`> 🤖 AI Agent` 头 + `@ <hostname>`):逐条覆盖表 +
   每个子 issue 一句话结论 + 残留 gap(如有)。末尾带 `<!-- rollup-done -->` marker
   (幂等 key)。
5. **处置**:全覆盖 → `gh issue close <N> -r completed`;有残留 gap → 列出并**留开**
   (残留是有界任务就按「partial → 拆分」拆自足 spin-off 并写边)。research/idea 类
   父 issue 同样综合后 close——结论已在子 issue/comment 落地,父级只是收口。
6. **release claim**:`claim.ts --release <claimId>`;带 `agent:ready` 的同时摘掉
   (消费方处理完摘——close 的 producer 下轮也会清,留开的必须现在摘,否则队列视图
   一直显示"可干"误导人和其他 worker)。

## ★「建议关闭」类结论清单 → 落地时立即挂 `agent:hold`(arc#2914)

任何本 skill 产出的**结论性批量处置清单**——doc-audit 汇总、★父级 rollup 综合 comment、
一次性全量 backlog audit 等场景里,表格/列表形式列出**多个 issue**并给出「建议关闭」/
「建议合并」/「建议删除」这类**需要人工复核才能执行**的结论——**在这份清单落地
(post 到 issue body 或 comment)的同一时刻**,必须对清单里点名的**每一个** issue 打上
`agent:hold`:

```bash
for n in <清单里点名的每个 issue 号>; do
  gh issue edit "$n" --add-label agent:hold
done
```

(label 不存在则先按 ★并发锁 acquire 段落的 `gh label create agent:hold ... || true` 幂等创建。)

**为什么不能只靠正文文字承诺(arc#1863 教训):** `#1863` 是一次一次性 138-issue 全量
backlog audit,body 末尾明确写「『建议关闭』一栏本次没有代关,等人扫一眼表格后批量关即
可」——这段自然语言承诺没有配套任何结构化信号。下一轮无人值守 sweep 把这段文字里点名的
12 个 issue 直接当成可执行指令关闭了,绕开了这里声明的人工确认闸(事后核对基本站得
住,但那是运气,不是设计——见 arc#2914)。`agent:hold` 是 `issue-sweep` Step 1「Then
drop the reserved/locked ones」已经尊重的既有确定性机制——**用它承载「等人复核」的承
诺,而不是指望下一轮 sweep 去解析 issue body 里的自然语言限定语**。这与 `issue-sweep`
Step 2 的对应规则互补:Step 2 保证即便某个被点名的 issue 意外漏挂 `agent:hold`,清单
本身也不会被当成指令消费——需要独立人工确认才行。

**人复核完摘 label**:批准 → 人自己 close(或摘掉 `agent:hold` 后走正常 sweep 流程);
否决 → 摘掉 `agent:hold` 并留一条说明。**agent 永不自动摘这个 label**(同上 ★并发锁
表的通用规则:`agent:hold` 只人加只人摘,本节是唯一的"自动加"例外,且不含"自动摘")。
