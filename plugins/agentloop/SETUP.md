# Fleet Setup — 从零到自动运行

给**第一次装 agentloop fleet** 的人。照着做就能跑起来,不需要先理解它怎么工作。

想知道原理、或要排查问题 → [`README.md`](README.md);driver 的完整语义 → [`fleet/README.md`](fleet/README.md)。

> 本文用 ArcBlock 的仓库做具体例子。换成你自己组织的 repo,把 owner/name 替换掉即可 —— 流程不变。

## 这是什么

一个 cron 驱动的循环:定时扫你指定的 repo,处理 issue、审 PR、开修复 PR。跑在**你自己的机器上**,用**你自己的 GitHub 身份**。多个人同时跑不会冲突 —— 谁先在 GitHub 上认领某个 issue/PR,其他人就跳过。

---

## 前置(3 项)

```bash
# 1) bun —— 安装器和 driver 都用它
bun --version || curl -fsSL https://bun.sh/install | bash

# 2) gh 已登录 —— 安装器从这里自动取 GitHub token,你不用手工粘贴
gh auth status

# 3) 把要覆盖的 repo clone 到同一个父目录
mkdir -p ~/Develop/arcblock && cd ~/Develop/arcblock
git clone git@github.com:ArcBlock/arc.git
git clone git@github.com:ArcBlock/did.git
```

第 3 项不是硬性要求(安装器也能自己 clone),但**强烈建议**:有本地 clone 时会用 worktree 模式复用 git object store,省几个 G 磁盘,每轮 checkout 也快得多。

**被覆盖的 repo 必须先跑过 `/agentloop:bootstrap`**(它会建 repo-profile + label + verify gate)。ArcBlock 的 arc / did / blockchain / arcblock-site 都已经跑过了。

---

## 第 1 步 · 装插件

```bash
claude plugin marketplace add https://github.com/ArcBlock/agent-skills.git
claude plugin install agentloop@arcblock-agent-skills
```

⚠️ **用完整 `https://` URL,不要用 `ArcBlock/agent-skills` 简写。** 简写形式默认走 SSH,没有 SSH key 的环境(尤其云端沙箱)会失败 —— 即使仓库是公开的。

验证:

```bash
claude plugin list | grep -A1 agentloop
```

**装完重启 Claude Code**,否则新 skill 不会被加载。

---

## 第 2 步 · 跑安装 skill

```
/agentloop:fleet-setup
```

问 4 个问题,**都有默认值,拿不准就用默认**:

| 问题 | 说明 | 建议 |
|---|---|---|
| **Runner** | 你的标识,出现在每条 agent 评论的署名行 | 你的名字 |
| **Repos** | 覆盖哪些 repo、各跑哪些 skill | 全选,skill 用 `issue-sweep` + `pr-sweep` |
| **Where** | 本机 crontab / 云端 routine / 两者 | **Local** |
| **Cadence + model** | 每个 repo 的间隔分钟数 + 模型 | 见下 |

### cadence 怎么定

**别一上来就设 60。** 依据是单轮实际耗时 —— 间隔比耗时短的话,下一轮会撞上还没跑完的上一轮,被锁挡掉,实际频率反而退回去。

参考(ArcBlock 实测中位耗时):

| repo | 中位 | 最长 | 建议 cadence |
|---|---|---|---|
| arc issue-sweep | ~30 分 | 114 分 | `120` |
| did | ~10 分 | 41 分 | `120` |
| arcblock-site | ~2 分 | 25 分 | `240` |
| blockchain | ~50 分 | 118 分 | `1440`(每天一次) |

先跑几天,用 `/agentloop:fleet-report` 看真实数据再调。

---

## 第 3 步 · 补一个 token

安装器会自动写好凭证文件,但有一项**故意留给你**。它的输出长这样:

```
✓ wrote ~/.agentloop-fleet/env (mode 600)
   ✓ GH_TOKEN (derived)
   → CLAUDE_CODE_OAUTH_TOKEN  RUN: claude setup-token, then paste it in
```

照做:

```bash
claude setup-token        # 走浏览器登录,输出 sk-ant-oat... 开头的 token
```

把它粘进 `~/.agentloop-fleet/env`,替换这一行的空值:

```bash
export CLAUDE_CODE_OAUTH_TOKEN=   # ← FILL: claude setup-token
```

**为什么不自动做**:`setup-token` 是交互式浏览器登录 —— 脚本不该去驱动你的登录流程,背着你铸出来的 token 也不该存在。

**为什么必须做**:cron 环境读不到 GUI 钥匙串。缺这个 token,每轮都会失败。

---

## 第 4 步 · 验证(跑之前先确认)

```bash
PLUGIN=~/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop

# 1) crontab 装上了吗 —— 应看到两行
crontab -l | sed -n '/agentloop-fleet:begin/,/agentloop-fleet:end/p'

# 2) dry-run:只打印计划,不执行、不写任何东西
bun "$PLUGIN/fleet/driver.ts" \
  --config ~/.agentloop-fleet/deployment.json \
  --catalog ~/.agentloop-fleet/repos.json \
  --skill issue-sweep

# 3) 凭证两个 key 都有值吗(只看 key 名,不打印值)
grep -oE '^export [A-Z_]+' ~/.agentloop-fleet/env
```

第 2 条应逐个 repo 打印完整命令行,末尾 `(dry-run — N/M due now …)`。

**看到这些就是没配好,别等 cron 自己跑:**

| 输出 | 原因 |
|---|---|
| `ReferenceError` / `Cannot access …` | 插件版本有问题,`claude plugin update` |
| `envFile set no variables` | 第 3 步没做完 |
| `checkoutBase not available` | 路径不存在(用了外置盘且没挂载?) |
| `base clone not found at …` | worktree 模式但那个 repo 没 clone 到 base dir |

---

## 第 5 步 · 看它跑

装好后**下一个 :09 / :39 附近**自动触发(具体分钟按 runner 名字错开,避免几个人同时打 GitHub)。

```
/agentloop:fleet-report          # 最近 7 天:跑了几轮、产出什么、耗时、有无残留进程
/agentloop:fleet-report 看图      # 生成 HTML 看板并打开
```

日志在 `~/.agentloop-fleet/logs/`:每个 (repo × skill) 一个 `.log`,加一个 `fleet.jsonl`(每轮一条结构化记录)。

---

## 五个坑

**① 绝对不要复制别人的 `~/.agentloop-fleet/`**
里面有 runner、绝对路径等机器特有字段。更糟的是别人可能加了本机专属的守卫(比如"外置盘没挂载就跳过") —— 抄过去之后 fleet **每轮静默跳过、一次都不跑,而且不报错**。永远用 `/agentloop:fleet-setup` 生成。

**② 第一轮很慢**
全新 checkout 要 clone + 装依赖(arc 约 1.9 G)。之后是热的。

**③ PR 会停在 "待人工 review"**
本机 cron 用你自己的 GitHub 账号,而 GitHub 禁止自己 approve 自己的 PR。**这是设计如此,不是坏了。**

**④ 磁盘**
每个 (repo × skill) 一个独立 checkout。4 repo × 2 skill ≈ 10–15 G。空间紧张就先只覆盖小 repo,别加 arc。

**⑤ 改配置不用重装**
`~/.agentloop-fleet/` 下两个文件:`deployment.json`(身份/路径/模型)、`repos.json`(覆盖范围/频率)。改完下一轮自动生效。重跑 `/agentloop:fleet-setup` 也安全 —— 幂等,且保留你手工加的字段。

---

## 进阶:让一个 repo 能读另一个 repo

某些 repo 的规范住在别的 repo 里 —— 比如一个内容/blocklet 仓库,它的页面格式和示例都在构建它的那个仓库里。这种情况下 agent 在自己的沙箱里**读不到那些规范,只能瞎猜**。

在 `repos.json` 给它加 `referenceRepos`:

```json
{
  "slug": "ArcBlock/arcblock-site",
  "skills": ["issue-sweep", "pr-sweep"],
  "referenceRepos": ["ArcBlock/arc"]
}
```

或在安装时用 `+` 后缀:`--repos "ArcBlock/arcblock-site=issue-sweep@240+ArcBlock/arc"`

被引用的 repo 会以**只读**方式浅克隆到 `<checkoutBase>/.reference/`,一份共享,每轮重置。它必须也在 catalog 里,否则安装器会报错而不是静默不挂载。
