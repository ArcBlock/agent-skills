#!/usr/bin/env bash
# Android Development Environment Setup
# Follows Linus principles: simple, idempotent, never break userspace

set -euo pipefail

# ============================================================================
# Configuration (Data structure first!)
# ============================================================================

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly LOG_FILE="${SCRIPT_DIR}/setup.log"
readonly BACKUP_DIR="${SCRIPT_DIR}/.backups"

# Color output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly NC='\033[0m' # No Color

# ============================================================================
# Logging
# ============================================================================

log() {
    echo -e "${GREEN}[INFO]${NC} $*" | tee -a "$LOG_FILE"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $*" | tee -a "$LOG_FILE"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*" | tee -a "$LOG_FILE"
}

# ============================================================================
# Core Functions: Check → Install → Verify (Same pattern for all tools)
# ============================================================================

check_command() {
    command -v "$1" &>/dev/null
}

check_homebrew() {
    check_command brew
}

install_homebrew() {
    if check_homebrew; then
        log "Homebrew already installed"
        return 0
    fi

    log "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
}

# ============================================================================
# SDKMAN Management
# ============================================================================

check_sdkman() {
    [[ -s "${HOME}/.sdkman/bin/sdkman-init.sh" ]]
}

install_sdkman() {
    if check_sdkman; then
        log "SDKMAN! already installed"
        return 0
    fi

    log "Installing SDKMAN!..."
    log "This is a user-level installation (no sudo required)"

    # Download and install SDKMAN!
    curl -s "https://get.sdkman.io" | bash

    # Source SDKMAN! for current session (disable strict mode temporarily for SDKMAN's variables)
    set +u
    source "${HOME}/.sdkman/bin/sdkman-init.sh"
    set -u

    log "✓ SDKMAN! installed successfully"
}

# ============================================================================
# JDK Management (using SDKMAN!)
# ============================================================================

check_jdk() {
    # Check if JDK 21 specifically is available
    local java_cmd=""
    local version=""

    # First check JAVA_HOME
    if [[ -n "${JAVA_HOME:-}" ]] && [[ -x "${JAVA_HOME}/bin/java" ]]; then
        java_cmd="${JAVA_HOME}/bin/java"
        version=$("$java_cmd" -version 2>&1 | head -n 1 | awk -F '"' '{print $2}')

        # Check if it's JDK 21
        if [[ "$version" == 21* ]]; then
            log "JDK 21 found: $version at $JAVA_HOME"
            return 0
        else
            log_warn "JDK found but not version 21: $version at $JAVA_HOME"
            log_warn "Will install JDK 21 alongside"
        fi
    fi

    # Check java in PATH
    if check_command java; then
        java_cmd="java"
        version=$(java -version 2>&1 | head -n 1 | awk -F '"' '{print $2}')

        if [[ "$version" == 21* ]]; then
            log "JDK 21 found in PATH: $version"
            return 0
        else
            log_warn "Java found in PATH but not version 21: $version"
            log_warn "Will install JDK 21"
        fi
    fi

    # Check SDKMAN! installations
    if check_sdkman; then
        set +u
        source "${HOME}/.sdkman/bin/sdkman-init.sh"
        set -u

        # Check for any JDK 21 version in SDKMAN!
        if [[ -d "${HOME}/.sdkman/candidates/java" ]]; then
            local jdk21_dir=$(ls -d "${HOME}/.sdkman/candidates/java/"21* 2>/dev/null | head -n 1)
            if [[ -n "$jdk21_dir" ]] && [[ -x "$jdk21_dir/bin/java" ]]; then
                local found_version=$("$jdk21_dir/bin/java" -version 2>&1 | head -n 1 | awk -F '"' '{print $2}')
                if [[ "$found_version" == 21* ]]; then
                    log "JDK 21 found in SDKMAN!: $found_version at $jdk21_dir"
                    return 0
                fi
            fi
        fi
    fi

    # Try to find JDK 21 using java_home (macOS)
    if command -v /usr/libexec/java_home &>/dev/null; then
        local jdk21_path
        jdk21_path=$(/usr/libexec/java_home -v 21 2>/dev/null)
        if [[ -n "$jdk21_path" ]]; then
            # Verify it's actually JDK 21, not a fallback
            local found_version
            found_version=$("$jdk21_path/bin/java" -version 2>&1 | head -n 1 | awk -F '"' '{print $2}')
            if [[ "$found_version" == 21* ]]; then
                log "JDK 21 found at: $jdk21_path"
                return 0
            else
                log_warn "java_home returned $jdk21_path but it's version $found_version, not 21"
            fi
        fi
    fi

    return 1
}

install_jdk() {
    if check_jdk; then
        log "JDK 21 already available, skipping installation"
        return 0
    fi

    # Temporarily disable strict undefined variable checking for SDKMAN! compatibility
    set +u

    # Ensure SDKMAN! is installed first
    install_sdkman || {
        log_error "Failed to install SDKMAN!"
        set -u
        return 1
    }

    # Source SDKMAN! for current session
    source "${HOME}/.sdkman/bin/sdkman-init.sh"

    log "Installing Eclipse Temurin JDK 21 via SDKMAN!..."
    log "Note: This will install to ~/.sdkman/candidates/java/"

    # Install JDK 21 using SDKMAN!
    # Use 21.0.5-tem (Eclipse Temurin 21)
    sdk install java 21.0.5-tem || {
        log_error "Failed to install JDK 21 via SDKMAN!"
        log "Trying alternative: latest 21.x version..."
        sdk install java 21-tem || {
            set -u
            return 1
        }
    }

    # Set as default version
    sdk default java 21.0.5-tem 2>/dev/null || sdk default java 21-tem 2>/dev/null

    log "✓ JDK 21 installed successfully"

    # Find the installed JDK path
    local jdk_path
    jdk_path=$(sdk home java 21.0.5-tem 2>/dev/null) || jdk_path=$(sdk home java 21-tem 2>/dev/null)

    if [[ -z "$jdk_path" ]]; then
        # Fallback: find in SDKMAN! directory
        jdk_path=$(ls -d "${HOME}/.sdkman/candidates/java/"21* 2>/dev/null | head -n 1)
    fi

    if [[ -z "$jdk_path" ]]; then
        log_error "JDK 21 installation succeeded but cannot determine path"
        set -u
        return 1
    fi

    log "JDK 21 path: $jdk_path"

    # Re-enable strict mode
    set -u

    # Configure shell (SDKMAN! handles JAVA_HOME automatically, but ensure init is sourced)
    configure_sdkman_init
}

configure_sdkman_init() {
    local shell_rc="${HOME}/.zshrc"

    # Backup existing config
    mkdir -p "$BACKUP_DIR"
    [[ -f "$shell_rc" ]] && cp "$shell_rc" "${BACKUP_DIR}/zshrc.backup.$(date +%Y%m%d_%H%M%S)"

    # Check if SDKMAN! init already in shell config
    if grep -q "sdkman-init.sh" "$shell_rc" 2>/dev/null; then
        log "SDKMAN! already configured in $shell_rc"
        return 0
    fi

    # Add SDKMAN! initialization
    log "Configuring SDKMAN! in $shell_rc"
    cat >> "$shell_rc" <<'EOF'

# SDKMAN! - Added by android-dev-setup
export SDKMAN_DIR="$HOME/.sdkman"
[[ -s "$HOME/.sdkman/bin/sdkman-init.sh" ]] && source "$HOME/.sdkman/bin/sdkman-init.sh"
EOF

    log "✓ SDKMAN! configured in shell"
    log "Note: SDKMAN! will automatically set JAVA_HOME to the default Java version"
}

configure_java_home() {
    # This function is now handled by SDKMAN! automatically
    # Kept for compatibility with existing code flow
    log "JDK configuration managed by SDKMAN!"
    configure_sdkman_init
}

verify_jdk() {
    if check_jdk; then
        local version
        version=$(java -version 2>&1 | head -n 1)
        log "✓ JDK verification passed: $version"
        return 0
    else
        log_error "✗ JDK verification failed"
        return 1
    fi
}

# ============================================================================
# Android SDK Management
# ============================================================================

check_android_sdk() {
    if [[ -n "${ANDROID_HOME:-}" ]] && [[ -d "${ANDROID_HOME}" ]]; then
        log "Android SDK found at: $ANDROID_HOME"
        return 0
    fi

    # Check common locations
    local common_paths=(
        "${HOME}/Library/Android/sdk"
        "/usr/local/share/android-sdk"
        "/opt/android-sdk"
    )

    for path in "${common_paths[@]}"; do
        if [[ -d "$path/cmdline-tools" ]] || [[ -d "$path/platform-tools" ]]; then
            log "Android SDK found at: $path"
            export ANDROID_HOME="$path"
            return 0
        fi
    done

    return 1
}

install_android_sdk() {
    if check_android_sdk; then
        log "Android SDK already available, skipping installation"
        return 0
    fi

    log "Installing Android Command Line Tools..."
    brew install --cask android-commandlinetools

    # Create SDK directory
    local sdk_path="${HOME}/Library/Android/sdk"
    mkdir -p "$sdk_path"

    # Find where Homebrew installed cmdline-tools
    local brew_cmdline_tools
    if [[ -d "/opt/homebrew/share/android-commandlinetools" ]]; then
        brew_cmdline_tools="/opt/homebrew/share/android-commandlinetools"
    elif [[ -d "/usr/local/share/android-commandlinetools" ]]; then
        brew_cmdline_tools="/usr/local/share/android-commandlinetools"
    else
        log_error "Cannot find android-commandlinetools installation"
        return 1
    fi

    log "Found cmdline-tools at: $brew_cmdline_tools"

    # Link cmdline-tools to SDK directory
    if [[ ! -d "$sdk_path/cmdline-tools" ]]; then
        ln -s "$brew_cmdline_tools/cmdline-tools" "$sdk_path/cmdline-tools"
        log "Linked cmdline-tools to SDK directory"
    fi

    # Configure ANDROID_HOME first (needed for sdkmanager)
    configure_android_home "$sdk_path"

    # Install essential SDK components using sdkmanager
    log "Installing essential SDK components..."

    # Accept licenses first
    yes | sdkmanager --licenses 2>/dev/null || true

    # Install platform-tools (adb, fastboot)
    log "Installing platform-tools..."
    sdkmanager "platform-tools" || {
        log_error "Failed to install platform-tools"
        return 1
    }

    # Install latest build-tools
    log "Installing build-tools..."
    sdkmanager "build-tools;35.0.0" || {
        log_warn "Failed to install build-tools 35.0.0, trying 34.0.0..."
        sdkmanager "build-tools;34.0.0" || true
    }

    # Install latest platform (Android SDK)
    log "Installing Android SDK Platform..."
    sdkmanager "platforms;android-35" || {
        log_warn "Failed to install platform 35, trying 34..."
        sdkmanager "platforms;android-34" || true
    }

    log "SDK components installation complete"
}

configure_android_home() {
    local sdk_path="$1"
    local shell_rc="${HOME}/.zshrc"

    # Backup
    mkdir -p "$BACKUP_DIR"
    [[ -f "$shell_rc" ]] && cp "$shell_rc" "${BACKUP_DIR}/zshrc.backup.$(date +%Y%m%d_%H%M%S)"

    # Check existing config
    if grep -q "ANDROID_HOME\|ANDROID_SDK_ROOT" "$shell_rc" 2>/dev/null; then
        log_warn "Android SDK already configured in $shell_rc"
        log_warn "Current config preserved (never break userspace!)"
        return 0
    fi

    # Append config
    log "Configuring ANDROID_HOME in $shell_rc"
    cat >> "$shell_rc" << EOF

# Android SDK - Added by setup.sh on $(date)
export ANDROID_HOME="$sdk_path"
export ANDROID_SDK_ROOT="\$ANDROID_HOME"
export PATH="\$ANDROID_HOME/cmdline-tools/latest/bin:\$PATH"
export PATH="\$ANDROID_HOME/platform-tools:\$PATH"
export PATH="\$ANDROID_HOME/emulator:\$PATH"
EOF

    # Set for current session
    export ANDROID_HOME="$sdk_path"
    export ANDROID_SDK_ROOT="$ANDROID_HOME"
    export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
    export PATH="$ANDROID_HOME/platform-tools:$PATH"

    log "ANDROID_HOME configured: $ANDROID_HOME"
}

verify_android_sdk() {
    if [[ -z "${ANDROID_HOME:-}" ]] || [[ ! -d "${ANDROID_HOME}" ]]; then
        log_error "✗ Android SDK verification failed: ANDROID_HOME not set or invalid"
        return 1
    fi

    log "✓ Android SDK verification passed: $ANDROID_HOME"

    # Check for essential tools
    local all_good=true

    if [[ -d "${ANDROID_HOME}/platform-tools" ]]; then
        log "  ✓ platform-tools: installed"

        # Verify adb is executable
        if [[ -x "${ANDROID_HOME}/platform-tools/adb" ]]; then
            local adb_version
            adb_version=$("${ANDROID_HOME}/platform-tools/adb" version 2>&1 | head -n 1)
            log "    - adb: $adb_version"
        fi
    else
        log_warn "  ✗ platform-tools: NOT installed"
        all_good=false
    fi

    if [[ -d "${ANDROID_HOME}/build-tools" ]]; then
        local build_tools_version
        build_tools_version=$(ls "${ANDROID_HOME}/build-tools" | tail -1)
        log "  ✓ build-tools: $build_tools_version"
    else
        log_warn "  ✗ build-tools: NOT installed"
        all_good=false
    fi

    if [[ -d "${ANDROID_HOME}/platforms" ]]; then
        local platforms_count
        platforms_count=$(ls -1 "${ANDROID_HOME}/platforms" 2>/dev/null | wc -l | tr -d ' ')
        log "  ✓ platforms: $platforms_count installed"
    else
        log_warn "  ✗ platforms: NOT installed"
        all_good=false
    fi

    if [[ "$all_good" == "true" ]]; then
        return 0
    else
        log_warn "Some SDK components are missing, but basic installation succeeded"
        return 0  # Don't fail the script, user can install more later
    fi
}

# ============================================================================
# Project Analysis (Read build.gradle to determine requirements)
# ============================================================================

analyze_project() {
    local project_dir="${1:-.}"

    if [[ ! -f "${project_dir}/build.gradle" ]] && [[ ! -f "${project_dir}/build.gradle.kts" ]]; then
        log_warn "No build.gradle found in $project_dir"
        log "Will install default Android SDK components"
        return 0
    fi

    log "Analyzing project requirements..."

    # TODO: Parse build.gradle for:
    # - compileSdk
    # - buildToolsVersion
    # - kotlinOptions.jvmTarget

    # For now, just log that we found the project
    log "Project found at: $project_dir"
}

# ============================================================================
# APK Build Functions
# ============================================================================

detect_project_root() {
    local search_dir="${1:-.}"

    # Look for gradlew in current or parent directories
    local current_dir="$(cd "$search_dir" && pwd)"

    while [[ "$current_dir" != "/" ]]; do
        if [[ -f "$current_dir/gradlew" ]] || [[ -f "$current_dir/build.gradle" ]] || [[ -f "$current_dir/build.gradle.kts" ]]; then
            echo "$current_dir"
            return 0
        fi
        current_dir="$(dirname "$current_dir")"
    done

    return 1
}

find_apk() {
    local project_dir="$1"

    # Common APK locations (prefer debug builds)
    local apk_paths=(
        "$project_dir/app/build/outputs/apk/debug/*.apk"
        "$project_dir/build/outputs/apk/debug/*.apk"
        "$project_dir/app/build/outputs/apk/release/*.apk"
        "$project_dir/build/outputs/apk/release/*.apk"
    )

    for pattern in "${apk_paths[@]}"; do
        local apk_file=$(ls -t $pattern 2>/dev/null | head -n 1)
        if [[ -n "$apk_file" && -f "$apk_file" ]]; then
            echo "$apk_file"
            return 0
        fi
    done

    return 1
}

build_apk() {
    local project_dir="${1:-.}"

    log "=========================================="
    log "Building APK"
    log "=========================================="

    # Detect project root
    local project_root
    if ! project_root=$(detect_project_root "$project_dir"); then
        log_error "Cannot find Android project in $project_dir"
        log_error "Expected to find gradlew, build.gradle, or build.gradle.kts"
        return 1
    fi

    log "Project root: $project_root"

    # Check for gradlew
    if [[ ! -f "$project_root/gradlew" ]]; then
        log_error "gradlew not found in $project_root"
        log_error "This doesn't appear to be a Gradle-based Android project"
        return 1
    fi

    # Ensure gradlew is executable
    chmod +x "$project_root/gradlew"

    # Clean previous builds (optional, commented for speed)
    # log "Cleaning previous builds..."
    # cd "$project_root" && ./gradlew clean

    # Build debug APK
    log "Building debug APK..."
    log "This may take a few minutes on first build..."

    if cd "$project_root" && ./gradlew assembleDebug; then
        log "✓ Build successful"

        # Find the built APK
        local apk_file
        if apk_file=$(find_apk "$project_root"); then
            log "✓ APK location: $apk_file"
            local apk_size=$(du -h "$apk_file" | cut -f1)
            log "  Size: $apk_size"

            # Save APK path for install function
            export BUILT_APK_PATH="$apk_file"
            return 0
        else
            log_error "Build succeeded but cannot find APK file"
            log_error "Checked common locations in $project_root/app/build/outputs/apk/"
            return 1
        fi
    else
        log_error "✗ Build failed"
        log_error "Check the error messages above"
        return 1
    fi
}

# ============================================================================
# Device & Installation Functions
# ============================================================================

print_developer_mode_guide() {
    echo ""
    echo "=========================================="
    echo "如何开启 Android 开发者模式"
    echo "=========================================="
    echo ""
    echo "📱 开启开发者选项:"
    echo "  1. 打开手机【设置】"
    echo "  2. 找到【关于手机】(有些手机在【系统】→【关于手机】)"
    echo "  3. 连续点击【版本号】7次"
    echo "  4. 输入锁屏密码(如果有)"
    echo "  5. 看到提示\"您已处于开发者模式\"即成功"
    echo ""
    echo "🔓 开启 USB 调试:"
    echo "  1. 返回【设置】主界面"
    echo "  2. 找到【开发者选项】(有些在【系统】→【开发者选项】)"
    echo "  3. 打开【开发者选项】总开关"
    echo "  4. 找到【USB调试】并打开"
    echo "  5. 确认弹出的授权提示"
    echo ""
    echo "🔌 连接电脑:"
    echo "  1. 使用 USB 数据线连接手机和电脑"
    echo "  2. 手机会弹出\"允许 USB 调试吗?\"对话框"
    echo "  3. 勾选【始终允许使用这台计算机进行调试】"
    echo "  4. 点击【允许】"
    echo ""
    echo "📝 常见品牌差异:"
    echo "  • 小米/Redmi: 设置→我的设备→全部参数→点击MIUI版本7次"
    echo "  • 华为/荣耀: 设置→关于手机→版本号(连点7次)"
    echo "  • OPPO/一加: 设置→关于手机→版本信息→版本号(连点7次)"
    echo "  • vivo: 设置→系统管理→关于手机→版本信息→软件版本号(连点7次)"
    echo "  • 三星: 设置→关于手机→软件信息→版本号(连点7次)"
    echo ""
    echo "⚠️  如果找不到开发者选项:"
    echo "  • 有些手机需要在【更多设置】或【系统】里找"
    echo "  • MIUI 需要额外打开【USB安装】和【USB调试(安全设置)】"
    echo "  • 部分厂商ROM需要登录账号才能开启"
    echo ""
    echo "=========================================="
    echo ""
}

check_adb_available() {
    if ! check_command adb; then
        log_error "adb command not found"
        log_error "Please ensure Android SDK platform-tools is installed"
        log_error "Run: ./setup.sh to install Android SDK"
        return 1
    fi
    return 0
}

check_devices() {
    if ! check_adb_available; then
        return 1
    fi

    log "Checking connected devices..."

    # Start adb server if needed
    adb start-server &>/dev/null

    local devices_output
    devices_output=$(adb devices | grep -v "List of devices" | grep -v "^$" | grep -v "^\*")

    if [[ -z "$devices_output" ]]; then
        log_warn "No devices detected"
        echo ""
        echo "请确保:"
        echo "  1. ✓ 手机已开启USB调试(见下方指南)"
        echo "  2. ✓ 手机已通过USB连接到电脑"
        echo "  3. ✓ 手机屏幕已解锁"
        echo "  4. ✓ 已在手机上授权USB调试"

        print_developer_mode_guide
        return 1
    fi

    # Parse device list
    local device_count=0
    local device_id=""

    while IFS= read -r line; do
        if [[ "$line" =~ ^([^[:space:]]+)[[:space:]]+(device|unauthorized|offline) ]]; then
            local id="${BASH_REMATCH[1]}"
            local status="${BASH_REMATCH[2]}"

            ((device_count++))

            if [[ "$status" == "device" ]]; then
                device_id="$id"
                local model=$(adb -s "$id" shell getprop ro.product.model 2>/dev/null | tr -d '\r')
                local android_version=$(adb -s "$id" shell getprop ro.build.version.release 2>/dev/null | tr -d '\r')
                log "✓ Device $device_count: $model (Android $android_version)"
                log "  ID: $id"
            elif [[ "$status" == "unauthorized" ]]; then
                log_error "✗ Device $device_count: $id (未授权)"
                echo "  → 请在手机上点击【允许USB调试】对话框"
            elif [[ "$status" == "offline" ]]; then
                log_warn "⚠ Device $device_count: $id (离线)"
                echo "  → 尝试重新插拔USB线,或重启adb: adb kill-server && adb start-server"
            fi
        fi
    done <<< "$devices_output"

    if [[ $device_count -eq 0 ]]; then
        log_error "No valid devices found"
        print_developer_mode_guide
        return 1
    fi

    if [[ -z "$device_id" ]]; then
        log_error "Devices detected but none are authorized"
        echo ""
        echo "请在手机上授权USB调试后重试"
        return 1
    fi

    # Export device ID for installation
    export TARGET_DEVICE_ID="$device_id"

    if [[ $device_count -gt 1 ]]; then
        log_warn "Multiple devices detected, will use: $device_id"
    fi

    return 0
}

install_apk() {
    local apk_path="${1:-${BUILT_APK_PATH}}"

    log "=========================================="
    log "Installing APK to Device"
    log "=========================================="

    # Validate APK path
    if [[ -z "$apk_path" ]]; then
        log_error "No APK specified"
        log "Usage: install_apk <path_to_apk>"
        log "Or: build_apk first, then install_apk will use the built APK"
        return 1
    fi

    if [[ ! -f "$apk_path" ]]; then
        log_error "APK file not found: $apk_path"
        return 1
    fi

    log "APK: $apk_path"

    # Check devices
    if ! check_devices; then
        return 1
    fi

    local device_id="${TARGET_DEVICE_ID}"

    # Install APK
    log "Installing on device: $device_id"
    log "This may take a moment..."

    if adb -s "$device_id" install -r "$apk_path"; then
        log "✓ Installation successful!"

        # Try to extract and launch the app (optional)
        local package_name
        if check_command aapt; then
            package_name=$(aapt dump badging "$apk_path" 2>/dev/null | grep "package: name=" | sed "s/.*name='\\([^']*\\)'.*/\\1/")
            if [[ -n "$package_name" ]]; then
                log "Package: $package_name"
                echo ""
                echo "要启动应用,请运行:"
                echo "  adb shell monkey -p $package_name 1"
            fi
        fi

        return 0
    else
        log_error "✗ Installation failed"
        echo ""
        echo "常见问题:"
        echo "  • 如果提示 INSTALL_FAILED_UPDATE_INCOMPATIBLE:"
        echo "    → 先卸载旧版本: adb uninstall <package_name>"
        echo "  • 如果提示 INSTALL_FAILED_INSUFFICIENT_STORAGE:"
        echo "    → 手机存储空间不足,请清理后重试"
        echo "  • 如果提示 INSTALL_FAILED_VERIFICATION_FAILURE:"
        echo "    → 关闭手机的【安装验证】或【纯净模式】"
        return 1
    fi
}

# ============================================================================
# Android Emulator Installation
# ============================================================================

install_emulator_optional() {
    log ""
    log "=========================================="
    log "Android Emulator (Optional)"
    log "=========================================="
    echo ""
    echo "要安装 Android 模拟器吗?"
    echo ""
    echo "${YELLOW}⚠️  注意: Android 模拟器可能会卡顿${NC}"
    echo ""
    echo "模拟器适用于:"
    echo "  ✓ 没有 Android 设备时进行测试"
    echo "  ✓ 测试不同 Android 版本"
    echo "  ✓ 自动化测试场景"
    echo ""
    echo "建议:"
    echo "  • 如果有真机设备，推荐使用真机（性能更好）"
    echo "  • Apple Silicon Mac 上 ARM 镜像性能较好"
    echo "  • 至少需要 8GB RAM 和 10GB 磁盘空间"
    echo ""
    echo -n "是否安装模拟器? (y/n): "
    read -r response

    if [[ "$response" =~ ^[Yy]$ ]]; then
        log "Installing Android Emulator..."

        # Call emulator installation script
        if [[ -f "${SCRIPT_DIR}/install-emulator.sh" ]]; then
            bash "${SCRIPT_DIR}/install-emulator.sh" install || {
                log_error "Emulator installation failed"
                log_warn "You can install it later by running:"
                log_warn "  ${SCRIPT_DIR}/install-emulator.sh install"
                return 1
            }
        else
            log_error "Emulator installation script not found"
            return 1
        fi
    else
        log "Skipping emulator installation"
        echo ""
        echo "如需后续安装模拟器，运行:"
        echo "  ${SCRIPT_DIR}/install-emulator.sh install"
    fi

    return 0
}

# ============================================================================
# ArcSphere Repository Clone
# ============================================================================

clone_arcsphere_optional() {
    log ""
    log "=========================================="
    log "ArcSphere Android Repository (Optional)"
    log "=========================================="
    echo ""
    echo "Do you want to clone the ArcSphere Android project?"
    echo ""
    echo "Repository: https://github.com/ArcBlock/arc-sphere-android"
    echo "Target location: ~/workspace/arc-sphere-android"
    echo ""
    echo "Details:"
    echo "  • Will try SSH protocol first (requires SSH key configured)"
    echo "  • Falls back to HTTPS if SSH fails"
    echo "  • HTTPS requires GitHub username and Personal Access Token"
    echo ""
    echo -n "Clone repository? (y/n): "
    read -r response

    if [[ "$response" =~ ^[Yy]$ ]]; then
        log "Cloning ArcSphere repository..."

        # Call clone script
        if [[ -f "${SCRIPT_DIR}/clone-repo.sh" ]]; then
            bash "${SCRIPT_DIR}/clone-repo.sh" || {
                log_error "Repository clone failed"
                log_warn "You can clone it later by running:"
                log_warn "  ${SCRIPT_DIR}/clone-repo.sh"
                return 1
            }
        else
            log_error "Clone script not found"
            return 1
        fi
    else
        log "Skipping repository clone"
        echo ""
        echo "To clone later, run:"
        echo "  ${SCRIPT_DIR}/clone-repo.sh"
    fi

    return 0
}

# ============================================================================
# Main Setup Flow
# ============================================================================

main() {
    log "=========================================="
    log "Android Development Environment Setup"
    log "=========================================="
    log "Started at: $(date)"
    log ""

    # Idempotent: safe to run multiple times
    log "Step 1: Ensure Homebrew is installed"
    install_homebrew || { log_error "Homebrew installation failed"; exit 1; }

    log ""
    log "Step 2: Install and configure JDK"
    install_jdk || { log_error "JDK installation failed"; exit 1; }
    verify_jdk || exit 1

    log ""
    log "Step 3: Install and configure Android SDK"
    install_android_sdk || { log_error "Android SDK installation failed"; exit 1; }
    verify_android_sdk || exit 1

    log ""
    log "Step 4: Optional - Android Emulator"
    install_emulator_optional || log_warn "Emulator installation skipped or failed"

    log ""
    log "Step 5: Optional - Clone ArcSphere Repository"
    clone_arcsphere_optional || log_warn "Repository clone skipped or failed"

    log ""
    log "=========================================="
    log "Setup completed successfully!"
    log "=========================================="
    log "Please restart your shell or run: source ~/.zshrc"
    log ""
    log "Log file: $LOG_FILE"
}

# Run if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
