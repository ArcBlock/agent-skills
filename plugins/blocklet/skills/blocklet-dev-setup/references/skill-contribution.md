# Skill 持续改进

当开发过程中遇到 **本 skill 未记录的问题** 并成功解决后，应主动询问用户是否将经验贡献回 skill。

## 触发条件

以下情况应触发改进询问：

| 场景 | 示例 |
|------|------|
| 遇到新的环境问题并解决 | bun 版本问题、nginx 配置、端口冲突等 |
| 发现更好的诊断/修复方法 | 更快的问题定位命令、更可靠的修复步骤 |
| 流程中有遗漏的步骤 | 某个必要的前置检查未包含 |
| 错误处理表缺少某类错误 | 新发现的常见错误模式 |

## 询问流程

使用 `AskUserQuestion`：

```
我刚刚解决了一个问题：{问题简述}

这个问题在当前 skill 文档中没有记录。是否需要我帮你将这个经验贡献到 agent-skills 仓库？

选项：
A. 是，帮我准备 PR（Recommended）
   - 我会拉取 agent-skills 仓库、创建分支、补充相关信息
B. 不需要，这是个特殊情况
C. 稍后再说
```

## PR 准备流程

**变量说明**:
- `{SKILL_NAME}`: 当前 skill 名称（如 `blocklet-dev-setup`、`blocklet-server-dev-setup`）

### 1. 确保仓库最新

```bash
SKILLS_REPO="$HOME/arcblock-repos/agent-skills"
cd "$SKILLS_REPO" && git checkout main && git pull origin main
```

### 2. 创建改进分支

```bash
SKILL_NAME="{SKILL_NAME}"
BRANCH_NAME="improve/${SKILL_NAME}-$(date +%Y%m%d)"
git checkout -b "$BRANCH_NAME"
```

### 3. 定位并修改 Skill 文件

```bash
SKILL_FILE="$SKILLS_REPO/plugins/blocklet/skills/${SKILL_NAME}/SKILL.md"
```

根据问题类型，在 skill 文件的相应位置补充内容：

| 问题类型 | 更新位置 |
|----------|----------|
| 环境问题 | 前置环境检查或 `Error Handling` |
| 流程问题 | 相应的 Phase/Workflow 章节 |
| 诊断方法 | `Error Handling` 章节 |

### 4. 提交并推送

```bash
git add -A
git commit -m "fix(${SKILL_NAME}): {改进描述}"
git push -u origin "$BRANCH_NAME"
```

### 5. 创建 PR

```bash
gh pr create \
  --title "fix(${SKILL_NAME}): {改进描述}" \
  --body "## 改进内容

- {简述改进的内容}

## 触发原因

- {描述遇到的问题}

## 测试

- [ ] 已验证改进内容有效"
```

## 输出模板

完成后输出以下信息：

```
===== Skill 改进 PR 已准备 =====

仓库: ~/arcblock-repos/agent-skills
分支: {BRANCH_NAME}
修改文件: plugins/blocklet/skills/{SKILL_NAME}/SKILL.md

已添加内容:
- {简述添加的内容}

下一步:
1. 请检查修改内容: git diff
2. 确认无误后创建 PR
```
