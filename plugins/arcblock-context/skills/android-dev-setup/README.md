# Android Dev Setup Skill

一键配置 Android 开发环境的 Claude Code Skill。

## 功能

### 环境配置
自动安装和配置:
- ☕ **JDK 21** (Eclipse Temurin) - 与最新 Android Studio 一致
- 🤖 **Android Command Line Tools**
- 🛠️ **Android SDK** (platform-tools, build-tools)
- 📝 **环境变量** (JAVA_HOME, ANDROID_HOME)
- 📦 **项目代码克隆** - 可选克隆 ArcSphere Android 仓库

### 构建与部署
- 🏗️ **编译APK** - 自动检测项目并执行Gradle构建
- 📱 **安装到设备** - 检测连接的Android设备并安装APK
- 🔍 **设备诊断** - 检查USB调试状态和设备连接
- 📖 **开发者模式指南** - 详细的各品牌手机开启教程
- 🖥️ **Android模拟器** - 安装和管理Android虚拟设备(AVD)

## 特性

✅ **幂等性**: 重复运行是安全的，只安装缺失的组件
✅ **向后兼容**: 从不覆盖现有配置，只添加新配置
✅ **自动备份**: 修改配置文件前自动备份
✅ **详细日志**: 所有操作记录到 `setup.log`

## 使用方法

### 方式 1: 直接运行脚本(推荐)

#### 初始环境配置
```bash
# 先诊断
~/.claude/skills/android-dev-setup/scripts/test.sh

# 再安装
~/.claude/skills/android-dev-setup/scripts/setup.sh
```

#### 构建和安装APK
```bash
# 进入你的Android项目目录
cd /path/to/your/android/project

# 一键构建并安装到手机
~/.claude/skills/android-dev-setup/scripts/build.sh build-install

# 或分步执行
~/.claude/skills/android-dev-setup/scripts/build.sh build   # 仅编译
~/.claude/skills/android-dev-setup/scripts/build.sh install app/build/outputs/apk/debug/app-debug.apk  # 仅安装

# 检查设备连接
~/.claude/skills/android-dev-setup/scripts/build.sh devices
```

#### 安装和使用模拟器
```bash
# 安装模拟器和创建默认AVD
~/.claude/skills/android-dev-setup/scripts/install-emulator.sh install

# 列出所有可用的模拟器
~/.claude/skills/android-dev-setup/scripts/install-emulator.sh list

# 启动模拟器
~/.claude/skills/android-dev-setup/scripts/install-emulator.sh start ArcSphere_Emulator
```

#### 克隆 ArcSphere 项目仓库
```bash
# 克隆 ArcSphere Android 项目代码
~/.claude/skills/android-dev-setup/scripts/clone-repo.sh

# 仓库位置: ~/workspace/arc-sphere-android
# 优先使用 SSH,失败时回退到 HTTPS
```

⚠️ **性能提示**: Android 模拟器可能会卡顿，建议：
- 优先使用真机设备（性能更好）
- Apple Silicon Mac 上使用 ARM 镜像性能较好
- 至少需要 8GB RAM 和 10GB 磁盘空间

### 方式 2: 通过 Claude Code Skill 系统

启动 Claude Code 时加载插件：

```bash
claude --plugin-dir ~/.claude/skills/android-dev-setup
```

然后在对话中输入：
```
/android-setup
```

Claude 会帮你运行诊断和安装脚本。

### 方式 3: 创建别名(便捷)

添加到 `~/.zshrc`:
```bash
alias android-test="~/.claude/skills/android-dev-setup/scripts/test.sh"
alias android-setup="~/.claude/skills/android-dev-setup/scripts/setup.sh"
alias android-build="~/.claude/skills/android-dev-setup/scripts/build.sh"
alias android-emulator="~/.claude/skills/android-dev-setup/scripts/install-emulator.sh"
alias android-clone="~/.claude/skills/android-dev-setup/scripts/clone-repo.sh"
```

重新加载后即可使用:
```bash
android-test         # 诊断环境
android-setup        # 安装SDK
android-build bi     # 构建并安装(bi = build-install)
android-emulator     # 管理模拟器
android-clone        # 克隆 ArcSphere 仓库
```

## 安装的工具

| 工具 | 版本 | 路径 |
|------|------|------|
| JDK | 21 | `/Library/Java/JavaVirtualMachines/temurin-21.jdk` |
| Android SDK | Latest | `~/Library/Android/sdk` |
| platform-tools | Latest | `$ANDROID_HOME/platform-tools` |

## 环境变量

脚本会自动配置以下环境变量到 `~/.zshrc`:

```bash
export JAVA_HOME="/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"

export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
```

**重要**: 配置后需要重启终端或执行 `source ~/.zshrc`。

## 验证安装

```bash
# 验证 JDK
java -version

# 验证 Android SDK
echo $ANDROID_HOME
ls $ANDROID_HOME

# 验证 adb
adb --version

# 验证设备连接(需要先连接手机)
adb devices
```

## 开启Android开发者模式

**首次使用前必读**: 要安装APK到手机,需要先开启USB调试。

### 通用步骤

1. **开启开发者选项**:
   - 打开【设置】→【关于手机】
   - 连续点击【版本号】7次
   - 看到提示"您已处于开发者模式"

2. **开启USB调试**:
   - 返回【设置】→【开发者选项】
   - 打开【USB调试】
   - 确认授权提示

3. **连接电脑**:
   - 用USB数据线连接手机和电脑
   - 手机弹出"允许USB调试吗?"对话框
   - 勾选【始终允许】并点击【允许】

### 各品牌手机差异

| 品牌 | 开启方式 |
|------|---------|
| 小米/Redmi | 设置→我的设备→全部参数→MIUI版本(连点7次) |
| 华为/荣耀 | 设置→关于手机→版本号(连点7次) |
| OPPO/一加 | 设置→关于手机→版本信息→版本号(连点7次) |
| vivo | 设置→系统管理→关于手机→软件版本号(连点7次) |
| 三星 | 设置→关于手机→软件信息→版本号(连点7次) |

**特殊提示**:
- MIUI系统需要额外打开【USB安装】和【USB调试(安全设置)】
- 部分厂商ROM需要登录账号才能开启开发者选项
- 如果找不到开发者选项,尝试在【更多设置】或【系统】里查找

详细指南可运行: `~/.claude/skills/android-dev-setup/scripts/build.sh devices`

## Android 模拟器

### 安装模拟器

运行 `setup.sh` 时会提示是否安装模拟器，或手动运行:

```bash
~/.claude/skills/android-dev-setup/scripts/install-emulator.sh install
```

安装过程会：
1. 显示性能警告（模拟器可能卡顿）
2. 检测系统架构（Apple Silicon 或 Intel）
3. 安装 Android Emulator 组件
4. 下载适合架构的系统镜像（ARM64 或 x86_64）
5. 创建默认 AVD: `ArcSphere_Emulator`
6. 配置性能优化参数

### 使用模拟器

```bash
# 列出所有模拟器
~/.claude/skills/android-dev-setup/scripts/install-emulator.sh list

# 启动默认模拟器
~/.claude/skills/android-dev-setup/scripts/install-emulator.sh start ArcSphere_Emulator

# 或使用 emulator 命令
emulator -avd ArcSphere_Emulator
```

### 性能优化建议

⚠️ **模拟器性能警告**: Android 模拟器可能会出现卡顿

**最佳实践**:
- **优先使用真机**: 真机性能远优于模拟器，且测试结果更准确
- **Apple Silicon Mac**: 使用 ARM64 系统镜像性能更好
- **内存要求**: 至少 8GB RAM，分配 2-4GB 给模拟器
- **磁盘空间**: 至少 10GB 可用空间
- **硬件加速**: 确保启用虚拟化技术(Intel VT-x/AMD-V)

**如果模拟器太慢**:
1. 使用真机设备测试（强烈推荐）
2. 减少模拟器分辨率
3. 选择较低 API 级别的系统镜像
4. 关闭不必要的模拟器功能（音频、传感器等）

### 模拟器 vs 真机

| 对比项 | 真机设备 | 模拟器 |
|--------|---------|--------|
| 性能 | ⭐⭐⭐⭐⭐ | ⭐⭐ |
| 测试准确性 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| 设置难度 | 简单（开启USB调试） | 中等（下载镜像、配置） |
| 多版本测试 | 需要多台设备 | 可创建多个AVD |
| 资源占用 | 无 | 高（RAM、CPU、磁盘） |
| 启动速度 | 即时 | 1-2分钟 |

**推荐**: 日常开发和测试使用真机设备，仅在需要测试多个Android版本或无设备时使用模拟器。

## 设计原则

遵循 Linus Torvalds 的工程哲学：

1. **简洁性**: 核心逻辑是 check → install → verify 循环
2. **数据结构优先**: 工具差异在数据，不在控制流
3. **Never break userspace**: 绝不破坏现有配置
4. **实用主义**: 解决真实问题，不过度设计

## 故障排除

### 问题: 命令找不到

```bash
# 确认环境变量已加载
source ~/.zshrc

# 或重启终端
```

### 问题: Homebrew 安装失败

手动安装 Homebrew:
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### 问题: 权限被拒绝

```bash
# 确保脚本有执行权限
chmod +x setup.sh
```

## 文件结构

```
android-dev-setup/
├── SKILL.md               # Skill定义文件
├── README.md              # 本文档
├── scripts/               # 脚本目录
│   ├── setup.sh           # 环境配置脚本
│   ├── test.sh            # 环境诊断脚本
│   ├── build.sh           # APK构建和安装脚本
│   ├── install.sh         # APK安装脚本
│   ├── check-device.sh    # 设备检查脚本
│   ├── install-emulator.sh # 模拟器安装和管理脚本
│   └── clone-repo.sh      # 仓库克隆脚本
├── docs/                  # 文档目录
│   ├── USAGE.md           # 详细使用指南
│   ├── QUICKREF.md        # 快速参考
│   ├── CHANGELOG.md       # 更新日志
│   ├── SDKMAN_MIGRATION.md # SDKMAN迁移指南
│   ├── task_plan.md       # 开发计划
│   ├── findings.md        # 发现记录
│   └── progress.md        # 进度记录
└── .backups/              # 配置文件备份（运行时生成）
```

## 开发

查看 `docs/task_plan.md` 了解开发路线图。

## License

MIT
