# 使用指南

## 快速开始

### 1. 诊断当前环境

在运行安装之前,先检查系统状态:

```bash
cd ~/.claude/skills/android-dev-setup
./test.sh
```

**示例输出：**
```
======================================
Android Dev Setup - Diagnostic Test
======================================

Test 1: Homebrew Detection
  ✅ Homebrew is installed
     Homebrew 5.0.9

Test 2: JDK Detection
  ✅ JDK is available
     openjdk version "17.0.13"
     JAVA_HOME: not set (will be configured)

Test 3: Android SDK Detection
  ❌ Android SDK is NOT installed

======================================
Summary
======================================
The following components need to be installed:
  - Android SDK

Run ./setup.sh to install missing components.
```

### 2. 运行自动安装

```bash
./setup.sh
```

脚本会:
1. 检测并安装 Homebrew(如果缺失)
2. 检测并安装 JDK 21(如果缺失)
3. 检测并安装 Android SDK(如果缺失)
4. 配置环境变量到 `~/.zshrc`
5. 备份所有修改的配置文件

**重要**: 安装完成后需要:
```bash
# 重新加载配置
source ~/.zshrc

# 或者重启终端
```

### 3. 验证安装

```bash
# 验证 JDK
java -version
echo $JAVA_HOME

# 验证 Android SDK
echo $ANDROID_HOME
ls $ANDROID_HOME

# 验证 adb(如果 platform-tools 已安装)
adb --version
```

### 4. 构建Android项目

#### 一键构建并安装
```bash
# 进入你的Android项目目录
cd /path/to/your/android/project

# 构建并安装到手机
~/.claude/skills/android-dev-setup/build.sh build-install
```

#### 仅构建APK
```bash
~/.claude/skills/android-dev-setup/build.sh build

# 或指定项目路径
~/.claude/skills/android-dev-setup/build.sh build /path/to/project
```

#### 仅安装APK
```bash
~/.claude/skills/android-dev-setup/build.sh install path/to/app.apk
```

#### 检查设备连接
```bash
~/.claude/skills/android-dev-setup/build.sh devices
```

## 开启Android开发者模式(重要!)

**首次安装APK前必读**: 要在手机上安装APK,必须先开启USB调试。

### 通用步骤

#### 第一步: 开启开发者选项
1. 打开手机【设置】
2. 找到【关于手机】(有些手机在【系统】→【关于手机】)
3. 找到【版本号】
4. **连续点击【版本号】7次**
5. 输入锁屏密码(如果有)
6. 看到提示"您已处于开发者模式"即成功

#### 第二步: 开启USB调试
1. 返回【设置】主界面
2. 找到【开发者选项】(有些在【系统】→【开发者选项】)
3. 打开【开发者选项】总开关(如果有)
4. 找到【USB调试】并打开
5. 确认弹出的授权提示

#### 第三步: 连接电脑
1. 使用**数据线**(不是充电线)连接手机和电脑
2. 手机会弹出"允许USB调试吗?"对话框
3. **勾选【始终允许使用这台计算机进行调试】**
4. 点击【允许】

#### 第四步: 验证连接
```bash
# 启动adb服务
adb start-server

# 查看连接的设备
adb devices

# 应该看到类似输出:
# List of devices attached
# 1234567890ABCDEF    device
```

### 各品牌手机差异

不同品牌的手机开启方式略有不同:

| 品牌 | 版本号位置 | 特殊说明 |
|------|-----------|---------|
| **小米/Redmi** | 设置→我的设备→全部参数→MIUI版本 | 需额外开启【USB安装】和【USB调试(安全设置)】 |
| **华为/荣耀** | 设置→关于手机→版本号 | 部分机型需要登录华为账号 |
| **OPPO/一加** | 设置→关于手机→版本信息→版本号 | ColorOS 12+可能需要额外步骤 |
| **vivo** | 设置→系统管理→关于手机→软件版本号 | 部分机型需要登录vivo账号 |
| **三星** | 设置→关于手机→软件信息→版本号 | 国行版可能有限制 |

### 常见问题

#### 1. 找不到开发者选项
- 确认是否点击了**7次**版本号
- 有些手机在【更多设置】或【系统】里
- 部分厂商ROM需要登录账号才能开启
- MIUI系统可能需要在线验证

#### 2. 手机提示"未授权"
```bash
# 查看设备状态
adb devices

# 如果显示 unauthorized:
# 1234567890ABCDEF    unauthorized
```
**解决方案**:
- 在手机上点击【允许USB调试】对话框
- 勾选【始终允许】
- 如果对话框消失,运行: `adb kill-server && adb start-server`

#### 3. 手机显示"离线"
```bash
# 设备显示 offline
# 1234567890ABCDEF    offline
```
**解决方案**:
- 重新插拔USB线
- 尝试更换USB接口
- 运行: `adb kill-server && adb start-server`
- 重启手机

#### 4. 完全检测不到设备
**检查清单**:
- [ ] USB数据线是否支持数据传输(不是只能充电的线)
- [ ] 手机屏幕是否已解锁
- [ ] USB调试是否已开启
- [ ] 电脑是否识别到手机(Mac系统偏好设置中能看到)
- [ ] 是否点击了手机上的授权对话框

**故障排除**:
```bash
# macOS: 重启adb服务
adb kill-server
adb start-server

# 查看adb日志
adb logcat

# 检查USB连接
system_profiler SPUSBDataType | grep -A 10 Android
```

#### 5. 安装失败: INSTALL_FAILED_UPDATE_INCOMPATIBLE
**原因**: 签名不一致,旧版本是用不同证书签名的

**解决方案**:
```bash
# 先卸载旧版本
adb uninstall <package_name>

# 例如:
adb uninstall com.example.myapp

# 然后重新安装
~/.claude/skills/android-dev-setup/build.sh install path/to/app.apk
```

#### 6. 安装失败: INSTALL_FAILED_INSUFFICIENT_STORAGE
**原因**: 手机存储空间不足

**解决方案**:
- 清理手机存储
- 删除不用的应用
- 清理微信/QQ等应用缓存

## 工作原理

### 幂等性保证

脚本可以安全地多次运行。每个组件都遵循 **check → install → verify** 模式：

```bash
check_jdk() {
    # 如果 JAVA_HOME 已设置且有效 → 返回成功
    # 如果 PATH 中有 java 命令 → 返回成功
    # 否则 → 返回失败
}

install_jdk() {
    # 先调用 check_jdk
    # 如果已安装 → 跳过安装，返回成功
    # 如果未安装 → 执行安装
}
```

### 配置文件备份

在修改 `~/.zshrc` 之前，脚本会自动备份：

```
.backups/
└── zshrc.backup.20260112_151030
```

### 环境变量配置

脚本会向 `~/.zshrc` 追加以下配置：

```bash
# Android Dev Setup - Added by setup.sh on 2026-01-12
export JAVA_HOME="/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"

# Android SDK - Added by setup.sh on 2026-01-12
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
export PATH="$ANDROID_HOME/emulator:$PATH"
```

**向后兼容保证**: 如果配置文件中已存在 `JAVA_HOME` 或 `ANDROID_HOME` 设置，脚本会保留现有配置，不会覆盖。

## 高级用法

### 仅检测不安装

使用诊断脚本：

```bash
./test.sh
```

### 查看安装日志

```bash
cat setup.log
```

日志包含：
- 每个步骤的详细输出
- 安装的工具版本
- 配置的路径
- 错误信息（如果有）

### 恢复备份的配置

如果需要撤销更改：

```bash
# 查看备份
ls .backups/

# 恢复特定备份
cp .backups/zshrc.backup.20260112_151030 ~/.zshrc

# 重新加载
source ~/.zshrc
```

## 常见问题

### Q: 脚本会删除我现有的配置吗？

**不会**。脚本遵循 "Never break userspace" 原则：
- 只追加配置，不覆盖
- 修改前自动备份
- 检测到现有配置时会保留

### Q: 我已经安装了 JDK，还能运行吗？

**可以**。脚本会检测到已安装的 JDK 并跳过安装步骤。如果 `JAVA_HOME` 未设置，脚本会配置环境变量。

### Q: 安装需要多长时间？

取决于网络速度和缺失的组件：
- Homebrew: ~5 分钟（如果需要安装）
- JDK 17: ~2 分钟
- Android SDK: ~5 分钟

### Q: 支持哪些系统？

当前版本针对 **macOS** 优化。使用：
- Homebrew 作为包管理器
- zsh 作为默认 shell

### Q: 如何卸载？

```bash
# 移除安装的工具
brew uninstall --cask temurin
brew uninstall --cask android-commandlinetools

# 恢复配置文件
cp .backups/zshrc.backup.XXXXXX ~/.zshrc
source ~/.zshrc

# 删除 Android SDK（可选）
rm -rf ~/Library/Android/sdk
```

### Q: 脚本安全吗？

是的。你可以：
1. 查看源代码（setup.sh 是纯 bash 脚本）
2. 先运行 `./test.sh` 进行诊断
3. 查看日志了解所有操作
4. 所有修改都有备份

## 故障排除

### 错误: "command not found"

```bash
# 确认环境变量已加载
echo $JAVA_HOME
echo $ANDROID_HOME

# 重新加载配置
source ~/.zshrc

# 或重启终端
```

### 错误: Homebrew 安装失败

手动安装 Homebrew 后重新运行：
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
./setup.sh
```

### 错误: 权限被拒绝

```bash
# 检查脚本权限
ls -l setup.sh

# 设置执行权限
chmod +x setup.sh
```

### 需要特定版本的 JDK？

编辑 `setup.sh` 中的安装命令：
```bash
# 当前：JDK 17
brew install --cask temurin

# 改为 JDK 21
brew install --cask temurin@21
```

## 文件说明

| 文件 | 用途 |
|------|------|
| `setup.sh` | 环境配置脚本(安装JDK和SDK) |
| `build.sh` | APK构建和安装脚本 |
| `test.sh` | 诊断脚本(不修改系统) |
| `setup.log` | 安装日志(自动生成) |
| `.backups/` | 配置文件备份目录 |
| `README.md` | 项目说明 |
| `USAGE.md` | 本使用指南 |

### build.sh 命令说明

`build.sh` 提供以下命令:

```bash
# 显示帮助
./build.sh help

# 构建APK
./build.sh build [project_dir]

# 安装APK到设备
./build.sh install <apk_path>

# 构建并安装(默认命令)
./build.sh build-install [project_dir]
./build.sh bi [project_dir]  # 简写

# 检查设备连接
./build.sh devices
./build.sh check  # 别名
```

**工作流程**:
1. **build**: 检测项目 → 运行`./gradlew assembleDebug` → 定位APK文件
2. **install**: 检查设备连接 → 运行`adb install -r` → 显示包名
3. **build-install**: 先build再install,一气呵成

## 开发者信息

- 规划文件: `task_plan.md`, `findings.md`, `progress.md`
- 设计原则: 遵循 Linus Torvalds 的工程哲学
- 测试: 所有功能已通过测试（见 `progress.md`）

## 反馈与贡献

发现问题或有改进建议？欢迎反馈！
