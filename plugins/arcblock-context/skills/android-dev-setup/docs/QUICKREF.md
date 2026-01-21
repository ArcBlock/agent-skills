# Android-Setup Skill 快速参考

## 📋 命令速查

### 环境管理

```bash
# 诊断环境
bash test.sh

# 安装/更新环境
bash setup.sh

# 验证安装
source ~/.zshrc && java -version
```

### 设备管理

```bash
# 检查连接的设备
bash check-device.sh

# 手动 ADB 命令
adb devices -l              # 列出设备
adb start-server            # 启动 ADB
adb kill-server             # 重启 ADB
```

### APK 安装

```bash
# 安装 APK
bash install.sh <apk_path>

# 示例
bash install.sh app/build/outputs/apk/develop/debug/develop.apk
```

### 项目构建

```bash
# 构建 Debug 版本
./gradlew assembleDevelopDebug

# 构建 Release 版本
./gradlew assembleDevelopRelease

# 清理并重新构建
./gradlew clean assembleDevelopDebug

# 完整流程：清理、构建、安装
./gradlew clean assembleDevelopDebug && bash install.sh app/build/outputs/apk/develop/debug/develop.apk
```

## 🔧 常见问题

### Q1: 检测不到设备怎么办？

**检查清单:**
1. ✅ USB 线连接正常（尝试换一根线）
2. ✅ 手机屏幕已解锁
3. ✅ 已开启开发者选项
4. ✅ 已开启 USB 调试
5. ✅ 在手机上授权了这台电脑

**解决步骤:**
```bash
# 1. 重启 ADB
adb kill-server && adb start-server

# 2. 检查设备
bash check-device.sh

# 3. 如果还不行，重新插拔 USB
```

### Q2: 设备显示 "unauthorized" 怎么办？

1. 查看手机屏幕，应该有授权对话框
2. 勾选 "始终允许使用这台计算机进行调试"
3. 点击 "允许"
4. 重新运行 `bash check-device.sh`

### Q3: 安装 APK 失败 "INSTALL_FAILED_UPDATE_INCOMPATIBLE"

**原因:** 签名不匹配

**解决:**
```bash
# 先卸载旧版本
adb uninstall com.arcblock.sphere.develop

# 再重新安装
bash install.sh app/build/outputs/apk/develop/debug/develop.apk
```

### Q4: 如何切换 JDK 版本？

```bash
# 列出可用版本
sdk list java

# 临时切换（仅当前终端）
sdk use java 17.0.13-tem

# 永久切换（设为默认）
sdk default java 21.0.5-tem
```

### Q5: Gradle 构建失败怎么办？

```bash
# 1. 停止 Gradle daemon
./gradlew --stop

# 2. 清理缓存
./gradlew clean

# 3. 重新构建
./gradlew assembleDevelopDebug

# 4. 如果还是失败，检查 JDK
java -version  # 应该是 21.0.5
echo $JAVA_HOME  # 应该指向 JDK 21
```

## 📱 设备操作速查

### 应用管理

```bash
# 列出所有包
adb shell pm list packages

# 查找特定应用
adb shell pm list packages | grep arcblock

# 卸载应用
adb uninstall com.arcblock.sphere.develop

# 启动应用
adb shell monkey -p com.arcblock.sphere.develop -c android.intent.category.LAUNCHER 1

# 清除应用数据
adb shell pm clear com.arcblock.sphere.develop
```

### 日志查看

```bash
# 实时查看所有日志
adb logcat

# 过滤特定标签
adb logcat | grep arcblock

# 保存日志到文件
adb logcat > debug.log

# 清除日志
adb logcat -c
```

### 文件操作

```bash
# 推送文件到设备
adb push local_file /sdcard/

# 从设备拉取文件
adb pull /sdcard/remote_file ./

# 截图
adb shell screencap /sdcard/screenshot.png
adb pull /sdcard/screenshot.png

# 录屏（最长 3 分钟）
adb shell screenrecord /sdcard/demo.mp4
# Ctrl+C 停止录制
adb pull /sdcard/demo.mp4
```

### 设备信息

```bash
# 设备型号
adb shell getprop ro.product.model

# Android 版本
adb shell getprop ro.build.version.release

# 屏幕分辨率
adb shell wm size

# 电池信息
adb shell dumpsys battery

# 内存信息
adb shell dumpsys meminfo

# CPU 信息
adb shell cat /proc/cpuinfo
```

## 🎯 工作流示例

### 完整开发流程

```bash
# 1. 检查环境
bash test.sh

# 2. 检查设备
bash check-device.sh

# 3. 构建应用
./gradlew clean assembleDevelopDebug

# 4. 安装到设备
bash install.sh app/build/outputs/apk/develop/debug/develop.apk

# 5. 查看日志
adb logcat | grep arcblock
```

### 快速迭代流程

```bash
# 修改代码后...

# 1. 增量构建（更快）
./gradlew assembleDevelopDebug

# 2. 安装（会自动覆盖）
bash install.sh app/build/outputs/apk/develop/debug/develop.apk

# 3. 查看崩溃日志
adb logcat *:E | grep arcblock
```

## 📁 文件位置

### 脚本位置
```
.claude/skills/android-dev-setup/
├── test.sh           - 环境诊断
├── setup.sh          - 环境安装
├── check-device.sh   - 设备检查
└── install.sh        - APK 安装
```

### 日志位置
```
.claude/skills/android-dev-setup/
├── setup.log         - 环境安装日志
└── install.log       - APK 安装日志
```

### APK 位置
```
app/build/outputs/apk/
├── develop/
│   ├── debug/develop.apk
│   └── release/develop.apk
└── production/
    ├── debug/production.apk
    └── release/production.apk
```

## 💡 提示和技巧

### 多设备管理

如果连接了多个设备：

```bash
# 1. 列出所有设备
adb devices

# 2. 指定设备执行命令
adb -s <device_id> install app.apk
adb -s <device_id> logcat
adb -s <device_id> shell ...
```

### 加速构建

```bash
# 使用并行构建
./gradlew assembleDevelopDebug --parallel

# 使用构建缓存
./gradlew assembleDevelopDebug --build-cache

# 离线模式（不检查依赖更新）
./gradlew assembleDevelopDebug --offline
```

### 调试技巧

```bash
# 只看错误日志
adb logcat *:E

# 看特定进程的日志
adb logcat --pid=$(adb shell pidof -s com.arcblock.sphere.develop)

# 保存崩溃日志
adb logcat -d *:E > crash.log
```

---

**版本**: 1.3.0
**更新**: 2026-01-13
