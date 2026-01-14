#!/usr/bin/env bash
# Install APK to connected Android device
# Part of android-dev-setup skill

set -euo pipefail

# ============================================================================
# Configuration
# ============================================================================

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly LOG_FILE="${SCRIPT_DIR}/install.log"

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
# Device Check
# ============================================================================

check_adb_available() {
    if ! command -v adb &>/dev/null; then
        log_error "adb command not found"
        log_error "Please ensure Android SDK platform-tools is installed"
        log_error "Run: bash setup.sh to install Android SDK"
        return 1
    fi
    return 0
}

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
    echo "=========================================="
    echo ""
}

check_devices() {
    if ! check_adb_available; then
        return 1
    fi

    log "正在检查连接的设备..."

    # Start adb server if needed
    adb start-server &>/dev/null

    local devices_output
    devices_output=$(adb devices | grep -v "List of devices" | grep -v "^$" | grep -v "^\*")

    if [[ -z "$devices_output" ]]; then
        log_warn "未检测到设备"
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
                log "✓ 设备 $device_count: $model (Android $android_version)"
                log "  ID: $id"
            elif [[ "$status" == "unauthorized" ]]; then
                log_error "✗ 设备 $device_count: $id (未授权)"
                echo "  → 请在手机上点击【允许USB调试】对话框"
            elif [[ "$status" == "offline" ]]; then
                log_warn "⚠ 设备 $device_count: $id (离线)"
                echo "  → 尝试重新插拔USB线,或重启adb: adb kill-server && adb start-server"
            fi
        fi
    done <<< "$devices_output"

    if [[ $device_count -eq 0 ]]; then
        log_error "未找到有效设备"
        print_developer_mode_guide
        return 1
    fi

    if [[ -z "$device_id" ]]; then
        log_error "检测到设备但没有授权"
        echo ""
        echo "请在手机上授权USB调试后重试"
        return 1
    fi

    # Export device ID for installation
    export TARGET_DEVICE_ID="$device_id"

    if [[ $device_count -gt 1 ]]; then
        log_warn "检测到多个设备，将使用: $device_id"
    fi

    return 0
}

# ============================================================================
# APK Installation
# ============================================================================

install_apk() {
    local apk_path="${1:-}"

    log "=========================================="
    log "正在安装 APK 到设备"
    log "=========================================="

    # Validate APK path
    if [[ -z "$apk_path" ]]; then
        log_error "未指定 APK 文件"
        echo "用法: bash install.sh <path_to_apk>"
        return 1
    fi

    if [[ ! -f "$apk_path" ]]; then
        log_error "APK 文件不存在: $apk_path"
        return 1
    fi

    log "APK: $apk_path"
    local apk_size=$(du -h "$apk_path" | cut -f1)
    log "大小: $apk_size"

    # Check devices
    if ! check_devices; then
        return 1
    fi

    local device_id="${TARGET_DEVICE_ID}"

    # Install APK
    log "正在安装到设备: $device_id"
    log "这可能需要一些时间..."

    if adb -s "$device_id" install -r "$apk_path" 2>&1 | tee -a "$LOG_FILE"; then
        log "✓ 安装成功!"

        # Try to get package name and launch
        local package_name
        # Try to extract package name from path
        if [[ "$apk_path" =~ develop ]]; then
            package_name="com.arcblock.sphere.develop"
        elif [[ "$apk_path" =~ production ]]; then
            package_name="com.arcblock.sphere.production"
        fi

        if [[ -n "${package_name:-}" ]]; then
            log "包名: $package_name"
            echo ""
            echo "要启动应用，请运行:"
            echo "  adb -s $device_id shell monkey -p $package_name -c android.intent.category.LAUNCHER 1"
            echo ""

            # Auto launch
            read -p "是否立即启动应用? (y/N): " -n 1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                log "正在启动应用..."
                adb -s "$device_id" shell monkey -p "$package_name" -c android.intent.category.LAUNCHER 1
                log "✓ 应用已启动"
            fi
        fi

        return 0
    else
        log_error "✗ 安装失败"
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
# Main
# ============================================================================

main() {
    log "=========================================="
    log "Android APK 安装工具"
    log "=========================================="
    log "开始时间: $(date)"
    log ""

    install_apk "$@"
}

# Run if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
