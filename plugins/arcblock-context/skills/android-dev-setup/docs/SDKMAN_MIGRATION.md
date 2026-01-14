# SDKMAN! Migration - Changelog

## Version 1.2.0 (2026-01-13)

### 主要改动

将 JDK 安装方式从 **Homebrew** 改为 **SDKMAN!**,实现无需 sudo 权限的用户级安装。

### 为什么迁移?

1. **无需 sudo 权限**: SDKMAN! 安装到用户主目录 (`~/.sdkman`),不需要管理员权限
2. **更好的版本管理**: 可轻松切换和管理多个 JDK 版本
3. **自动环境配置**: SDKMAN! 自动管理 `JAVA_HOME` 和 PATH
4. **跨平台一致性**: SDKMAN! 在 macOS、Linux 上表现一致

### 技术实现

#### 新增函数

```bash
check_sdkman()          # 检查 SDKMAN! 是否已安装
install_sdkman()        # 安装 SDKMAN! (无需 sudo)
configure_sdkman_init() # 配置 shell 初始化脚本
```

#### 修改的函数

- **check_jdk()**: 新增对 SDKMAN! 安装路径的检测
  - 检查 `~/.sdkman/candidates/java/21*`
  - 保留对系统 JDK 的兼容性检测

- **install_jdk()**: 完全重写
  ```bash
  # 旧方式 (Homebrew - 需要 sudo)
  brew install --cask temurin@21

  # 新方式 (SDKMAN! - 无需 sudo)
  sdk install java 21.0.5-tem
  sdk default java 21.0.5-tem
  ```

- **configure_java_home()**: 简化
  - SDKMAN! 自动管理 JAVA_HOME
  - 只需确保 `sdkman-init.sh` 被 source

#### 关键技术点

**Bash 严格模式兼容性**

SDKMAN! 内部使用了一些未设置的变量,与 `set -euo pipefail` 冲突。解决方案:

```bash
install_jdk() {
    # 临时禁用 -u (未绑定变量检查)
    set +u

    # SDKMAN! 操作
    source "${HOME}/.sdkman/bin/sdkman-init.sh"
    sdk install java 21.0.5-tem

    # 恢复严格模式
    set -u
}
```

### 安装路径对比

| 方式 | 安装路径 | 权限要求 |
|------|---------|---------|
| **Homebrew (旧)** | `/Library/Java/JavaVirtualMachines/` | ✗ 需要 sudo |
| **SDKMAN! (新)** | `~/.sdkman/candidates/java/` | ✓ 无需 sudo |

### 环境变量配置

**自动配置到 `~/.zshrc`:**

```bash
# SDKMAN! - Added by android-dev-setup
export SDKMAN_DIR="$HOME/.sdkman"
[[ -s "$HOME/.sdkman/bin/sdkman-init.sh" ]] && source "$HOME/.sdkman/bin/sdkman-init.sh"
```

SDKMAN! 会自动设置:
- `JAVA_HOME` → `~/.sdkman/candidates/java/current`
- PATH 包含 `$JAVA_HOME/bin`

### 使用指南

#### 安装 JDK 21

```bash
# 运行安装脚本
bash setup.sh

# 或手动安装
sdk install java 21.0.5-tem
sdk default java 21.0.5-tem
```

#### 管理多个 JDK 版本

```bash
# 列出所有可用版本
sdk list java

# 安装其他版本
sdk install java 17.0.13-tem
sdk install java 11.0.25-tem

# 切换默认版本
sdk default java 21.0.5-tem

# 临时使用特定版本 (仅当前 shell)
sdk use java 17.0.13-tem
```

#### 验证安装

```bash
# 重新加载配置
source ~/.zshrc

# 检查版本
java -version
# 输出: openjdk version "21.0.5" 2024-10-15 LTS

# 检查路径
echo $JAVA_HOME
# 输出: /Users/username/.sdkman/candidates/java/current
```

### 向后兼容性

✅ 脚本仍支持检测通过其他方式安装的 JDK 21:
- Homebrew 安装的 JDK (`/Library/Java/JavaVirtualMachines/`)
- macOS 的 `/usr/libexec/java_home -v 21`
- 环境变量 `JAVA_HOME`

### 测试验证

**测试环境:**
- macOS 24.6.0 (Darwin)
- 已有 JDK 17 (Corretto)

**测试结果:**
- ✅ SDKMAN! 安装成功
- ✅ JDK 21.0.5-tem 下载并安装
- ✅ 自动设置为默认版本
- ✅ 环境变量正确配置
- ✅ 与已有 JDK 17 共存无冲突
- ✅ Android SDK 安装继续正常

### 文件修改清单

- ✏️ `setup.sh` - JDK 安装逻辑重写
- ✏️ `skills/android-setup/skill.md` - 更新版本号和说明
- 📄 `setup.sh.backup` - 原始备份
- 📄 `SDKMAN_MIGRATION.md` - 本文档

### 升级建议

如果你之前已经通过 Homebrew 安装了 JDK 21:

1. **保留现有安装** - SDKMAN! 会与之共存
2. **切换到 SDKMAN! (可选)**:
   ```bash
   # 卸载 Homebrew 版本 (可选)
   brew uninstall --cask temurin@21

   # 安装 SDKMAN! 版本
   sdk install java 21.0.5-tem
   sdk default java 21.0.5-tem
   ```

### 参考资料

- [SDKMAN! 官方文档](https://sdkman.io/)
- [SDKMAN! Usage](https://sdkman.io/usage)
- [Eclipse Temurin](https://adoptium.net/)

---

**变更日期**: 2026-01-13
**变更作者**: Claude (Antigravity)
**测试状态**: ✅ 通过
