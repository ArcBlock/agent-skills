#!/usr/bin/env bash
# Test script for android-dev-setup
# Runs detection functions without making changes

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source the main script to get functions
source "${SCRIPT_DIR}/setup.sh"

echo "======================================"
echo "Android Dev Setup - Diagnostic Test"
echo "======================================"
echo ""

# Test 1: Homebrew
echo "Test 1: Homebrew Detection"
if check_homebrew; then
    echo "  ✅ Homebrew is installed"
    brew --version | head -1 | sed 's/^/     /'
else
    echo "  ❌ Homebrew is NOT installed"
fi
echo ""

# Test 2: JDK
echo "Test 2: JDK Detection"
if check_jdk; then
    echo "  ✅ JDK is available"
    java -version 2>&1 | head -1 | sed 's/^/     /'
    if [[ -n "${JAVA_HOME:-}" ]]; then
        echo "     JAVA_HOME: $JAVA_HOME"
    else
        echo "     JAVA_HOME: not set (will be configured)"
    fi
else
    echo "  ❌ JDK is NOT installed"
fi
echo ""

# Test 3: Android SDK
echo "Test 3: Android SDK Detection"
if check_android_sdk; then
    echo "  ✅ Android SDK is installed"
    echo "     ANDROID_HOME: $ANDROID_HOME"

    # Check components
    if [[ -d "${ANDROID_HOME}/platform-tools" ]]; then
        echo "     platform-tools: ✓"
        if [[ -x "${ANDROID_HOME}/platform-tools/adb" ]]; then
            echo "       - adb: available"
        fi
    else
        echo "     platform-tools: ✗ (needs installation)"
    fi

    if [[ -d "${ANDROID_HOME}/build-tools" ]]; then
        bt_count=$(ls -1 "${ANDROID_HOME}/build-tools" 2>/dev/null | wc -l | tr -d ' ')
        echo "     build-tools: ✓ ($bt_count versions)"
    else
        echo "     build-tools: ✗ (needs installation)"
    fi

    if [[ -d "${ANDROID_HOME}/platforms" ]]; then
        plat_count=$(ls -1 "${ANDROID_HOME}/platforms" 2>/dev/null | wc -l | tr -d ' ')
        echo "     platforms: ✓ ($plat_count installed)"
    else
        echo "     platforms: ✗ (needs installation)"
    fi

    if [[ -d "${ANDROID_HOME}/cmdline-tools" ]]; then
        echo "     cmdline-tools: ✓"
    fi
else
    echo "  ❌ Android SDK is NOT installed"
fi
echo ""

# Summary
echo "======================================"
echo "Summary"
echo "======================================"

needs_install=()
check_homebrew &>/dev/null || needs_install+=("Homebrew")
check_jdk &>/dev/null || needs_install+=("JDK")
check_android_sdk &>/dev/null || needs_install+=("Android SDK")

if [[ ${#needs_install[@]} -eq 0 ]]; then
    echo "✅ All components are installed!"
    echo ""
    echo "Your Android development environment is ready."
else
    echo "The following components need to be installed:"
    for item in "${needs_install[@]}"; do
        echo "  - $item"
    done
    echo ""
    echo "Run ./setup.sh to install missing components."
fi

echo ""
echo "======================================"
