#!/usr/bin/env bash
# Check connected Android devices
# Part of android-dev-setup skill

set -euo pipefail

# ============================================================================
# Configuration
# ============================================================================

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Color output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m' # No Color

# ============================================================================
# Helper Functions
# ============================================================================

log() {
    echo -e "${GREEN}[INFO]${NC} $*"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*"
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
    echo "📝 常见品牌差异:"
    echo "  • 小米/Redmi: 设置→我的设备→全部参数→点击MIUI版本7次"
    echo "  • 华为/荣耀: 设置→关于手机→版本号(连点7次)"
    echo "  • OPPO/一加: 设置→关于手机→版本信息→版本号(连点7次)"
    echo "  • vivo: 设置→系统管理→关于手机→版本信息→软件版本号(连点7次)"
    echo "  • 三星: 设置→关于手机→软件信息→版本号(连点7次)"
    echo "  • Google Pixel: 设置→关于手机→版本号(连点7次)"
    echo ""
    echo "=========================================="
    echo ""
}

# ============================================================================
# Device Check
# ============================================================================

check_adb_available() {
    if ! command -v adb &>/dev/null; then
        log_error "adb 命令未找到"
        echo ""
        echo "请先安装 Android SDK:"
        echo "  bash $SCRIPT_DIR/setup.sh"
        return 1
    fi
    return 0
}

check_devices() {
    echo "=========================================="
    echo "Android 设备检查"
    echo "=========================================="
    echo ""

    if ! check_adb_available; then
        return 1
    fi

    log "启动 ADB 服务器..."
    adb start-server &>/dev/null

    log "正在扫描连接的设备..."
    echo ""

    local devices_output
    devices_output=$(adb devices -l | grep -v "List of devices" | grep -v "^$" | grep -v "^\*")

    if [[ -z "$devices_output" ]]; then
        log_error "❌ 未检测到任何设备"
        echo ""
        echo "请检查:"
        echo "  1. ✓ 手机已通过 USB 连接到电脑"
        echo "  2. ✓ 手机屏幕已解锁"
        echo "  3. ✓ 手机已开启 USB 调试"
        echo "  4. ✓ 已在手机上授权此电脑"

        print_developer_mode_guide
        return 1
    fi

    # Parse and display device info
    local device_count=0
    local authorized_count=0

    while IFS= read -r line; do
        if [[ "$line" =~ ^([^[:space:]]+)[[:space:]]+(device|unauthorized|offline) ]]; then
            local id="${BASH_REMATCH[1]}"
            local status="${BASH_REMATCH[2]}"

            ((device_count++))

            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo -e "${BLUE}设备 #$device_count${NC}"
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

            if [[ "$status" == "device" ]]; then
                ((authorized_count++))

                # Get detailed device info
                local model=$(adb -s "$id" shell getprop ro.product.model 2>/dev/null | tr -d '\r')
                local manufacturer=$(adb -s "$id" shell getprop ro.product.manufacturer 2>/dev/null | tr -d '\r')
                local android_version=$(adb -s "$id" shell getprop ro.build.version.release 2>/dev/null | tr -d '\r')
                local sdk_version=$(adb -s "$id" shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r')
                local fingerprint=$(adb -s "$id" shell getprop ro.build.fingerprint 2>/dev/null | tr -d '\r')

                log "✅ 状态: 已授权并就绪"
                echo "  📱 设备ID: $id"
                echo "  🏭 制造商: $manufacturer"
                echo "  📦 型号: $model"
                echo "  🤖 Android 版本: $android_version (API $sdk_version)"
                echo "  🔧 构建指纹: ${fingerprint:0:60}..."

                # Check storage
                local storage=$(adb -s "$id" shell df /data 2>/dev/null | tail -1 | awk '{print $4}')
                if [[ -n "$storage" ]]; then
                    echo "  💾 可用存储: $storage"
                fi

                # Check battery
                local battery=$(adb -s "$id" shell dumpsys battery 2>/dev/null | grep level | awk '{print $2}')
                if [[ -n "$battery" ]]; then
                    echo "  🔋 电池电量: $battery%"
                fi

            elif [[ "$status" == "unauthorized" ]]; then
                log_error "❌ 状态: 未授权"
                echo "  📱 设备ID: $id"
                echo ""
                echo "  → 请在手机上点击【允许USB调试】对话框"
                echo "  → 建议勾选【始终允许使用这台计算机进行调试】"

            elif [[ "$status" == "offline" ]]; then
                log_warn "⚠️  状态: 离线"
                echo "  📱 设备ID: $id"
                echo ""
                echo "  → 尝试重新插拔 USB 线"
                echo "  → 或重启 ADB: adb kill-server && adb start-server"
            fi
            echo ""
        fi
    done <<< "$devices_output"

    echo "=========================================="
    echo "摘要"
    echo "=========================================="
    echo "  总计设备: $device_count"
    echo "  已授权设备: $authorized_count"
    echo "=========================================="
    echo ""

    if [[ $authorized_count -eq 0 ]]; then
        log_error "没有可用的已授权设备"

        if [[ $device_count -gt 0 ]]; then
            echo "检测到设备但未授权，请在手机上授权 USB 调试"
        else
            echo "未检测到任何设备，请参考上面的设置指南"
        fi

        return 1
    else
        log "✅ 有 $authorized_count 个设备可用于安装"

        if [[ $authorized_count -gt 1 ]]; then
            echo ""
            echo "提示: 安装 APK 时将使用第一个设备"
            echo "如需指定设备，使用: adb -s <device_id> install <apk>"
        fi

        echo ""
        echo "下一步:"
        echo "  • 安装 APK: bash install.sh <apk_path>"
        echo "  • 查看日志: adb logcat"
        echo "  • 推送文件: adb push <local> <remote>"

        return 0
    fi
}

# ============================================================================
# Main
# ============================================================================

main() {
    check_devices
}

# Run if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
