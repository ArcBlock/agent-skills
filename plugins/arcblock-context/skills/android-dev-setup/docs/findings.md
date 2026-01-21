# Findings & Decisions

## Requirements
<!-- 从用户需求捕获 -->
- 创建一个自动化配置 Android 开发环境的 Claude Code Skill
- 支持检测项目需求（从 Gradle 配置读取）
- 自动安装缺失的工具（JDK、Android SDK、Gradle 等）
- 确保不破坏现有环境配置
- 目标平台：macOS（用户当前系统：Darwin 24.6.0）

## Research Findings
<!-- 探索阶段的关键发现 -->

### Android 项目典型依赖
- **JDK**: Android Studio 最新版推荐 JDK 21（AGP 9.0+），AGP 8.0+ 支持 JDK 17，最低 JDK 11
- **Android SDK**: 通过 `cmdline-tools` 安装，包含：
  - `platform-tools` (adb, fastboot)
  - `build-tools;<version>` (aapt, dx, zipalign)
  - `platforms;android-<api-level>` (android.jar)
- **Gradle**: 通常通过 gradle-wrapper 管理，但系统需要有 JDK
- **NDK** (可选): 仅当项目有 C/C++ 代码时需要

### macOS 安装最佳实践
- **Homebrew**: 最可靠的包管理器
  - `brew install --cask temurin` (Eclipse Temurin JDK)
  - `brew install --cask android-commandlinetools`
- **jabba**: JDK 版本管理工具（类似 nvm）
- **sdkmanager**: Android SDK 官方 CLI 工具

### ⚠️ Homebrew android-commandlinetools 的实际行为

**关键发现（Bug #1 的根源）：**

`brew install --cask android-commandlinetools` **只做了这些事**：
1. 下载 Android cmdline-tools
2. 解压到 `/opt/homebrew/share/android-commandlinetools/cmdline-tools/`
3. 创建 `/opt/homebrew/bin/sdkmanager` 符号链接

**它不会做：**
- ❌ 创建 `~/Library/Android/sdk` 目录
- ❌ 下载 platform-tools（adb、fastboot）
- ❌ 下载 build-tools
- ❌ 下载任何 Android platform（android.jar）
- ❌ 接受 SDK 许可证

**正确的完整安装步骤：**
```bash
# 1. Homebrew 安装 cmdline-tools
brew install --cask android-commandlinetools

# 2. 创建 SDK 目录结构
mkdir -p ~/Library/Android/sdk

# 3. 链接 cmdline-tools 到标准位置
ln -s /opt/homebrew/share/android-commandlinetools/cmdline-tools \
      ~/Library/Android/sdk/cmdline-tools

# 4. 设置环境变量（必须先设置，sdkmanager 依赖此变量）
export ANDROID_HOME=~/Library/Android/sdk
export PATH=$ANDROID_HOME/cmdline-tools/latest/bin:$PATH

# 5. 接受许可证
yes | sdkmanager --licenses

# 6. 使用 sdkmanager 安装实际组件
sdkmanager "platform-tools"      # adb, fastboot
sdkmanager "build-tools;35.0.0"  # aapt, dx, zipalign
sdkmanager "platforms;android-35" # android.jar
```

**教训：Never assume, always verify。**

### 环境变量检测策略
```bash
# JDK 检测
echo $JAVA_HOME
java -version

# Android SDK 检测
echo $ANDROID_HOME (或 $ANDROID_SDK_ROOT)
sdkmanager --list_installed

# Gradle 检测
./gradlew --version (项目内)
gradle --version (全局，不推荐依赖)
```

### 项目配置解析点
- `build.gradle` / `build.gradle.kts`:
  - `compileSdk`
  - `buildToolsVersion`
  - `kotlinOptions.jvmTarget`
- `gradle-wrapper.properties`:
  - `distributionUrl` (包含 Gradle 版本)
- `gradle.properties`:
  - `org.gradle.java.home` (JDK 路径)

## Technical Decisions

| Decision | Rationale |
|----------|-----------|
| 使用 Homebrew 作为主要安装方式 | macOS 生态标准，可靠性高，社区支持好 |
| 优先检测项目内 Gradle Wrapper | 避免全局 Gradle 版本冲突 |
| 使用 `cmdline-tools` 而非完整 Android Studio | 最小化安装，符合 CLI 开发场景 |
| 环境变量写入 `.zshrc` | macOS 默认 shell 是 zsh |
| 幂等性：所有操作支持重复执行 | 用户可以安全地多次运行 Skill |
| 只添加路径，不修改已有配置 | 遵循 "Never break userspace" 原则 |

## Issues Encountered
<!-- 错误和解决方案 -->

| Issue | Resolution |
|-------|------------|
| **Bug #1**: 脚本假设 Homebrew 会创建完整 SDK 目录 | 修复：创建 SDK 目录，使用 sdkmanager 安装组件 |
| **Bug #1 根因**: Homebrew 只装 cmdline-tools，不装 SDK 组件 | 添加：`sdkmanager "platform-tools" "build-tools" "platforms"` |
| **Bug #1 症状**: 安装后 `ANDROID_HOME` 目录为空 | 修复：符号链接 + sdkmanager 下载实际文件 |

## Resources
<!-- URLs、文件路径、API 参考 -->

### 官方文档
- [Android Studio 命令行工具](https://developer.android.com/studio/command-line)
- [sdkmanager 使用指南](https://developer.android.com/studio/command-line/sdkmanager)
- [Gradle Plugin 版本对应关系](https://developer.android.com/studio/releases/gradle-plugin)

### 工具下载
- [Eclipse Temurin JDK](https://adoptium.net/)
- [Android 命令行工具](https://developer.android.com/studio#command-tools)
- [jabba (JDK 版本管理)](https://github.com/shyiko/jabba)

### Claude Code Skill 开发
- 当前工作目录: `/Users/alvin/.claude/skills/android-dev-setup`
- Skill 结构参考: TBD（需要查看其他 Skill 的示例）

## Visual/Browser Findings
<!-- 多模态内容必须立即捕获为文本 -->
- 尚未执行浏览器/视觉操作

---
**Linus 式复杂度分析：**

**好的设计应该是：**
```bash
# 一个函数搞定所有工具的安装
install_tool() {
  local tool=$1
  check_installed "$tool" && return 0
  download "$tool"
  configure "$tool"
  verify "$tool"
}

# 主逻辑：循环处理工具列表
for tool in jdk android-sdk gradle; do
  install_tool "$tool"
done
```

**糟糕的设计是：**
```bash
# 每个工具一坨 if/else
if ! command -v java; then
  # 50 行 JDK 安装逻辑
fi

if ! command -v adb; then
  # 另外 50 行 Android SDK 安装逻辑
fi
# ... 无限重复
```

**数据结构比代码重要：** 把差异放在数据里，而不是控制流里。
