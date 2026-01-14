# Task Plan: Android Dev Environment Setup Skill

## Goal
创建一个 Claude Code Skill，能够自动检测 Android 项目需求并配置完整的开发环境（JDK、Android SDK、Gradle、NDK 等）

## Current Phase
Phase 1

## Phases

### Phase 1: Requirements & Discovery
- [ ] 分析典型 Android 项目的环境依赖（build.gradle、gradle-wrapper.properties）
- [ ] 列出需要安装的工具清单（JDK、cmdline-tools、platform-tools、build-tools）
- [ ] 调研 macOS 上的最佳安装方式（Homebrew vs sdkmanager）
- [ ] 确定检测策略（如何判断工具已安装？版本匹配？）
- **Status:** in_progress

### Phase 2: Skill Structure Design
- [ ] 定义 Skill 的输入接口（自动检测 vs 手动指定项目路径）
- [ ] 设计配置文件格式（如果需要自定义）
- [ ] 规划脚本结构（检测、安装、验证）
- [ ] 设计错误处理机制（网络失败、权限问题、版本冲突）
- **Status:** pending

### Phase 3: Detection Logic Implementation
- [ ] 实现项目需求解析（读取 Gradle 配置）
- [ ] 实现系统状态检测（JAVA_HOME、ANDROID_HOME、已安装的 SDK 组件）
- [ ] 实现依赖计算（比较需求和现状，生成安装清单）
- [ ] 单元测试检测逻辑
- **Status:** pending

### Phase 4: Installation Logic Implementation
- [ ] 实现 JDK 安装（Homebrew + jabba 版本管理）
- [ ] 实现 Android SDK 安装（cmdline-tools + sdkmanager）
- [ ] 实现环境变量配置（.zshrc / .bashrc 修改，保证不破坏现有配置）
- [ ] 实现幂等性（重复运行不会重复安装）
- **Status:** pending

### Phase 5: Verification & Integration
- [ ] 实现验证逻辑（运行 `./gradlew --version`、`adb devices` 等）
- [ ] 创建 Skill manifest（claude.json 或类似配置）
- [ ] 编写 README 文档
- [ ] 端到端测试（在干净环境测试完整流程）
- **Status:** pending

### Phase 6: Delivery
- [ ] 生成最终的 Skill 包
- [ ] 编写使用指南
- [ ] 提供示例项目测试
- **Status:** pending

## Key Questions

1. **JDK 版本管理策略？**
   - 选项 A：只安装单一版本（简单但不灵活）
   - 选项 B：使用 jabba/SDKMAN（复杂但支持多版本）

2. **如何处理已存在但版本不匹配的工具？**
   - 选项 A：强制覆盖（有风险）
   - 选项 B：并存安装，提示用户切换（安全）

<!-- 3. **是否需要支持代理配置？**
   - 国内用户可能需要镜像加速

4. **是否需要 NDK？**
   - 仅当项目有 native 代码时才需要 -->

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| 优先使用 Homebrew | macOS 最成熟的包管理器，可靠性高 |
| 使用 cmdline-tools 而非 Android Studio | 最小化安装，符合 CLI 场景 |
| 只添加配置，不删除 | Never break userspace - 不破坏现有环境 |
| 幂等性设计 | 重复运行应该是安全的，只安装缺失的部分 |

## Errors Encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
| - | - | - |

## Notes

### Linus 式设计原则应用

**数据结构优先：**
```
ProjectRequirements {
  jdk_version: "17"
  gradle_version: "8.0"
  compile_sdk: "34"
  build_tools: "34.0.0"
  ndk_required: false
}

SystemState {
  jdk_installed: ["11", "17"]
  android_home: "/usr/local/share/android-sdk"
  sdk_packages: ["platform-tools", "build-tools;34.0.0"]
}

InstallPlan = ProjectRequirements - SystemState
```

**消除特殊情况：**
- 所有工具统一处理：检测 → 判断 → 安装 → 验证
- 不要为每个工具写独立的 if/else 分支

**简洁性：**
- 核心逻辑应该是一个循环：`for tool in install_plan: install(tool)`
- 复杂度在数据（如何检测、如何安装），不在控制流

**向后兼容：**
- 绝不修改已存在的 JAVA_HOME
- 只追加环境变量，不覆盖
- 安装前备份配置文件
