# Escalation — hard-stop report

> Full hard-stop table and the ⏸ report template. The decision of when to stop stays in `SKILL.md`. Read this when escalating.

## Escalation Rules（什么时候必须停下来问用户）

**这些是 hard stop 条件。遇到时立即停止自动执行，向用户报告情况并等待指令。不要自己猜测或绕过。**

### 必须停下来的情况

| 条件 | 触发 | 报告内容 |
|------|------|----------|
| **连续失败 3 次** | 同一个 test/build/verify 失败 3 次，每次 fix 都没解决 | 贴出 3 次的错误信息 + 你尝试了什么 + 你的猜测 |
| **E2E log 写不进去** | Layer 2 跑过一轮之后 `<planning-dir>/logs/s{N}-e2e.log` 仍缺失/空白/无 JSON | 贴出执行的命令 + 实际响应 + 你的诊断；**不要**伪造 log 蒙混过关 |
| **Spec 歧义** | tasks.md 对某个行为有两种合理解读，选哪个会影响后续 phase | 列出两种解读 + 各自影响 + 你的倾向 |
| **需要外部操作** | 需要用户配置环境、提供 credentials、启动外部服务、安装系统依赖 | 说明需要什么 + 为什么 + 用户操作步骤 |
| **架构决策** | 实现过程中发现 tasks.md 没覆盖到的设计选择，且影响不可逆 | 描述决策点 + 选项 + tradeoff |
| **Scope 溢出** | 发现要完成当前 phase 必须改 spec 外的代码，改动量超预期 | 列出额外改动 + 为什么需要 + 是否应该拆 phase |
| **测试覆盖疑问** | tasks.md 的测试 spec 没覆盖到你发现的重要场景 | 描述场景 + 为什么重要 + 建议的测试 |
| **性能异常** | verify Layer 2 发现性能比预期差 10x 以上 | 贴出数据 + 瓶颈分析 |

### 报告格式

遇到 hard stop 时，用这个格式：

```markdown
## ⏸ Phase N 需要你的输入

**停止原因：** {条件名}
**当前进度：** {做到哪一步了}
**问题描述：** {具体是什么}

**我尝试过的：**
1. ...
2. ...
3. ...

**我的判断：** {你觉得应该怎么做}
**需要你：** {具体需要用户做什么}
```

### 不应该停下来的情况

以下情况自己解决，不要打断用户：

- 普通的 type error → 自己 fix
- 测试失败但原因明确 → 自己 fix
- import 路径错误 → 自己 fix
- 需要安装一个 npm dev dependency → 自己 `<package_manager> add -D`
- Lint/format 错误 → 自己 `<formatter>`
- 一次就修好的 bug → 自己修

**判断标准：如果你有信心（>80%）能在 1-2 次尝试内解决，自己做。如果连续失败或不确定方向，停下来。**
