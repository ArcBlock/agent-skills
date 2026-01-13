# ArcBlock Context Plugin

公司知识库插件：产品、技术架构、战略方向。

## 功能

- **自动加载**：通过 `claude.md` 中的 ALP 策略，根据上下文自动加载相关文件
- **按需查询**：使用 `/company-context` 显式加载公司上下文
- **覆盖机制**：支持项目级和用户级 override

## 目录结构

```
arcblock-context/
├── products/           # 产品文档
│   ├── README.md       # 产品索引
│   ├── arcsphere.md
│   ├── agent-fleet.md
│   └── ...
├── technical/          # 技术架构
│   ├── README.md       # 技术索引
│   ├── afs.md
│   ├── aine.md
│   └── ...
├── strategy/           # 公司战略
│   └── README.md
└── skills/
    └── company-context/
        └── SKILL.md    # /company-context 技能
```

## 加载优先级

1. **项目级 override**: `./.claude/arcblock-context/`
2. **用户级 override**: `~/.claude/arcblock-context/`
3. **插件默认**: 本插件目录

## 使用场景

### 团队成员
直接使用插件提供的知识库，无需额外配置。

### 个人定制
在 `~/.claude/arcblock-context/` 创建同名文件覆盖默认内容：
```bash
mkdir -p ~/.claude/arcblock-context/products
# 创建或修改特定产品文档
```

### 项目定制
在项目 `.claude/arcblock-context/` 创建同名文件覆盖：
```bash
mkdir -p .claude/arcblock-context/technical
# 项目特定的技术决策
```

## 核心定位

**ArcBlock 是一个 AI-Native Engineering Company**

技术核心：AFS + AINE 是"母体"，其他产品都是自然衍生。
