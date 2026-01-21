#!/usr/bin/env bash
# Android APK Build and Install Script
# Follows Linus principles: simple, idempotent, never break userspace

set -euo pipefail

# ============================================================================
# Source the main setup script for shared functions
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source main setup.sh for shared utilities
if [[ -f "$SCRIPT_DIR/setup.sh" ]]; then
    source "$SCRIPT_DIR/setup.sh"
else
    echo "Error: Cannot find setup.sh"
    exit 1
fi

# ============================================================================
# Build and Install Workflow
# ============================================================================

show_usage() {
    cat <<EOF
Android APK Build & Install Tool

Usage:
  $0 [command] [options]

Commands:
  build [dir]           Build APK from Android project (default: current dir)
  install <apk>         Install APK to connected device
  build-install [dir]   Build and install in one step (default workflow)
  devices               Check connected devices and show developer mode guide

Examples:
  # Build and install from current directory
  $0 build-install

  # Build only
  $0 build

  # Install specific APK
  $0 install app/build/outputs/apk/debug/app-debug.apk

  # Check devices
  $0 devices

Environment:
  Requires Android SDK to be installed. Run ./setup.sh first.
EOF
}

cmd_build() {
    local project_dir="${1:-.}"
    build_apk "$project_dir"
}

cmd_install() {
    local apk_path="$1"
    install_apk "$apk_path"
}

cmd_build_install() {
    local project_dir="${1:-.}"

    # Build first
    if build_apk "$project_dir"; then
        echo ""
        log "Build completed, proceeding to installation..."
        echo ""

        # Install the built APK
        install_apk "$BUILT_APK_PATH"
    else
        log_error "Build failed, skipping installation"
        exit 1
    fi
}

cmd_devices() {
    log "=========================================="
    log "Device Detection"
    log "=========================================="

    if check_devices; then
        log ""
        log "Device ready for installation!"
    else
        log_error "No authorized devices found"
        log "Please follow the guide above to enable USB debugging"
        exit 1
    fi
}

# ============================================================================
# Main Entry Point
# ============================================================================

main() {
    local command="${1:-build-install}"

    case "$command" in
        build)
            shift
            cmd_build "$@"
            ;;
        install)
            shift
            if [[ $# -eq 0 ]]; then
                log_error "install command requires APK path"
                show_usage
                exit 1
            fi
            cmd_install "$@"
            ;;
        build-install|bi)
            shift
            cmd_build_install "$@"
            ;;
        devices|check)
            cmd_devices
            ;;
        help|-h|--help)
            show_usage
            ;;
        *)
            log_error "Unknown command: $command"
            show_usage
            exit 1
            ;;
    esac
}

# Run if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
