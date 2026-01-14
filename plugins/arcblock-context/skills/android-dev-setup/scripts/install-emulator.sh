#!/usr/bin/env bash
# Android Emulator Installation Script
# Installs Android Emulator and creates a default AVD

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="${SCRIPT_DIR}/emulator.log"

# Color output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly NC='\033[0m' # No Color

# ============================================================================
# Logging Functions
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
# Performance Warning
# ============================================================================

show_performance_warning() {
    echo ""
    echo "=========================================="
    echo "⚠️  Android 模拟器性能提示"
    echo "=========================================="
    echo ""
    echo "${YELLOW}注意: Android 模拟器可能会出现卡顿${NC}"
    echo ""
    echo "模拟器性能取决于:"
    echo "  • CPU: 需要支持虚拟化技术(Intel VT-x/AMD-V)"
    echo "  • 内存: 建议至少 8GB RAM，分配 2-4GB 给模拟器"
    echo "  • 磁盘: 需要至少 10GB 可用空间"
    echo "  • 架构: ARM 镜像在 Apple Silicon Mac 上性能更好"
    echo ""
    echo "如果模拟器太慢，建议:"
    echo "  1. 使用真机设备测试（推荐）"
    echo "  2. 减少模拟器分辨率"
    echo "  3. 选择较低 API 级别的系统镜像"
    echo "  4. 确保启用了硬件加速(HAXM/Hypervisor)"
    echo ""
    echo "=========================================="
    echo ""
}

# ============================================================================
# Check Prerequisites
# ============================================================================

check_android_sdk() {
    if [[ -z "${ANDROID_HOME:-}" ]]; then
        log_error "ANDROID_HOME not set"
        log_error "Please run setup.sh first to install Android SDK"
        return 1
    fi

    if [[ ! -d "${ANDROID_HOME}" ]]; then
        log_error "ANDROID_HOME directory does not exist: $ANDROID_HOME"
        return 1
    fi

    log "Android SDK found at: $ANDROID_HOME"
    return 0
}

check_sdkmanager() {
    if ! command -v sdkmanager &>/dev/null; then
        log_error "sdkmanager not found in PATH"
        log_error "Please ensure Android SDK cmdline-tools is installed"
        return 1
    fi
    return 0
}

# ============================================================================
# Detect System Architecture
# ============================================================================

detect_arch() {
    local arch=$(uname -m)
    local system_image_arch=""

    case "$arch" in
        arm64|aarch64)
            log "Detected Apple Silicon (ARM64)"
            system_image_arch="arm64-v8a"
            ;;
        x86_64)
            log "Detected Intel x86_64"
            system_image_arch="x86_64"
            ;;
        *)
            log_warn "Unknown architecture: $arch, defaulting to x86_64"
            system_image_arch="x86_64"
            ;;
    esac

    echo "$system_image_arch"
}

# ============================================================================
# Install Emulator Components
# ============================================================================

install_emulator_tools() {
    log "=========================================="
    log "Installing Android Emulator"
    log "=========================================="

    if ! check_android_sdk; then
        return 1
    fi

    if ! check_sdkmanager; then
        return 1
    fi

    # Show performance warning
    show_performance_warning

    # Ask for confirmation
    echo "是否继续安装 Android 模拟器? (y/n)"
    read -r response
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        log "Installation cancelled by user"
        return 0
    fi

    # Accept licenses
    log "Accepting SDK licenses..."
    yes | sdkmanager --licenses 2>/dev/null || true

    # Install emulator package
    log "Installing emulator package..."
    sdkmanager "emulator" || {
        log_error "Failed to install emulator"
        return 1
    }

    # Detect architecture
    local arch=$(detect_arch)

    # Install platform-tools if not already installed
    log "Ensuring platform-tools is installed..."
    sdkmanager "platform-tools" || true

    # Install system image based on architecture
    log "Installing system image for $arch..."

    # Try latest stable API level (API 34 - Android 14)
    local api_level="34"
    local image_type="google_apis"  # google_apis includes Play Store
    local system_image="system-images;android-${api_level};${image_type};${arch}"

    log "Installing: $system_image"
    if sdkmanager "$system_image"; then
        log "✓ System image installed: $system_image"
    else
        log_warn "Failed to install API 34, trying API 33..."
        api_level="33"
        system_image="system-images;android-${api_level};${image_type};${arch}"
        if sdkmanager "$system_image"; then
            log "✓ System image installed: $system_image"
        else
            log_error "Failed to install system image"
            return 1
        fi
    fi

    # Export for AVD creation
    export INSTALLED_SYSTEM_IMAGE="$system_image"
    export API_LEVEL="$api_level"

    log "✓ Emulator tools installed successfully"
    return 0
}

# ============================================================================
# Create AVD (Android Virtual Device)
# ============================================================================

create_default_avd() {
    log "=========================================="
    log "Creating Default AVD"
    log "=========================================="

    local avd_name="ArcSphere_Emulator"
    local system_image="${INSTALLED_SYSTEM_IMAGE:-}"

    if [[ -z "$system_image" ]]; then
        log_error "System image not set. Run install_emulator_tools first."
        return 1
    fi

    # Check if AVD already exists
    if avdmanager list avd | grep -q "Name: $avd_name"; then
        log_warn "AVD '$avd_name' already exists"
        echo "要删除并重新创建吗? (y/n)"
        read -r response
        if [[ "$response" =~ ^[Yy]$ ]]; then
            log "Deleting existing AVD..."
            avdmanager delete avd -n "$avd_name"
        else
            log "Keeping existing AVD"
            return 0
        fi
    fi

    # Create AVD
    log "Creating AVD: $avd_name"
    log "System image: $system_image"

    # Create with default device profile (Pixel 5)
    echo "no" | avdmanager create avd \
        -n "$avd_name" \
        -k "$system_image" \
        -d "pixel_5" \
        --force || {
        log_error "Failed to create AVD"
        return 1
    }

    # Configure AVD for better performance
    local avd_config="${HOME}/.android/avd/${avd_name}.avd/config.ini"
    if [[ -f "$avd_config" ]]; then
        log "Configuring AVD for optimal performance..."

        # Backup original config
        cp "$avd_config" "${avd_config}.backup"

        # Apply performance settings
        cat >> "$avd_config" <<EOF

# Performance optimizations - Added by install-emulator.sh
hw.ramSize=2048
hw.gpu.enabled=yes
hw.gpu.mode=auto
hw.keyboard=yes
hw.audioInput=no
hw.audioOutput=no
disk.dataPartition.size=4096M
vm.heapSize=256
EOF

        log "✓ Performance settings applied"
    fi

    log "✓ AVD created successfully: $avd_name"

    export CREATED_AVD_NAME="$avd_name"
    return 0
}

# ============================================================================
# List Available AVDs
# ============================================================================

list_avds() {
    log "=========================================="
    log "Available AVDs"
    log "=========================================="

    if ! command -v avdmanager &>/dev/null; then
        log_error "avdmanager not found"
        return 1
    fi

    local avd_list=$(avdmanager list avd)

    if echo "$avd_list" | grep -q "Available Android Virtual Devices:"; then
        echo "$avd_list"
    else
        log_warn "No AVDs found"
        echo ""
        echo "运行以下命令创建模拟器:"
        echo "  $0 install"
    fi
}

# ============================================================================
# Start Emulator
# ============================================================================

start_emulator() {
    local avd_name="${1:-}"

    if [[ -z "$avd_name" ]]; then
        log "Available AVDs:"
        list_avds
        echo ""
        log_error "Please specify AVD name: $0 start <avd_name>"
        return 1
    fi

    # Check if emulator is in PATH
    if ! command -v emulator &>/dev/null; then
        log_error "emulator command not found"
        log_error "Add to PATH: export PATH=\"\$ANDROID_HOME/emulator:\$PATH\""
        return 1
    fi

    log "Starting emulator: $avd_name"
    log "This may take 1-2 minutes on first boot..."

    # Show performance reminder
    log_warn "提醒: 模拟器可能会卡顿，建议使用真机测试"

    # Start emulator in background
    nohup emulator -avd "$avd_name" \
        -gpu auto \
        -no-snapshot-load \
        -wipe-data \
        > "${SCRIPT_DIR}/emulator_${avd_name}.log" 2>&1 &

    local emulator_pid=$!
    log "Emulator started with PID: $emulator_pid"
    log "Monitor logs: tail -f ${SCRIPT_DIR}/emulator_${avd_name}.log"

    # Wait for device to come online
    log "Waiting for emulator to boot..."

    local timeout=180  # 3 minutes
    local elapsed=0

    while [[ $elapsed -lt $timeout ]]; do
        if adb devices | grep -q "emulator.*device"; then
            log "✓ Emulator is online!"
            adb devices
            return 0
        fi
        sleep 5
        elapsed=$((elapsed + 5))
        echo -n "."
    done

    echo ""
    log_error "Emulator did not boot within ${timeout} seconds"
    log "Check logs: ${SCRIPT_DIR}/emulator_${avd_name}.log"
    return 1
}

# ============================================================================
# Main Command Handler
# ============================================================================

print_usage() {
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Commands:"
    echo "  install           - Install emulator and create default AVD"
    echo "  list              - List available AVDs"
    echo "  start <avd_name>  - Start an AVD"
    echo "  help              - Show this help"
    echo ""
    echo "Examples:"
    echo "  $0 install"
    echo "  $0 list"
    echo "  $0 start ArcSphere_Emulator"
}

main() {
    local command="${1:-help}"

    case "$command" in
        install)
            install_emulator_tools || exit 1
            create_default_avd || exit 1

            echo ""
            log "=========================================="
            log "Installation Complete!"
            log "=========================================="
            echo ""
            echo "启动模拟器:"
            echo "  $0 start ${CREATED_AVD_NAME:-ArcSphere_Emulator}"
            echo ""
            echo "或使用命令:"
            echo "  emulator -avd ${CREATED_AVD_NAME:-ArcSphere_Emulator}"
            echo ""
            log_warn "注意: 首次启动可能需要 1-2 分钟，且可能会卡顿"
            ;;

        list)
            list_avds
            ;;

        start)
            local avd_name="${2:-}"
            if [[ -z "$avd_name" ]]; then
                # Try to find default AVD
                if avdmanager list avd | grep -q "Name: ArcSphere_Emulator"; then
                    avd_name="ArcSphere_Emulator"
                else
                    list_avds
                    echo ""
                    log_error "Please specify AVD name: $0 start <avd_name>"
                    exit 1
                fi
            fi
            start_emulator "$avd_name"
            ;;

        help|--help|-h)
            print_usage
            ;;

        *)
            log_error "Unknown command: $command"
            print_usage
            exit 1
            ;;
    esac
}

# Run if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
