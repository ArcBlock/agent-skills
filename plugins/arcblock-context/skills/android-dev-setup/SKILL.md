---
name: android-setup
version: "1.4.0"
description: Set up Android development environment (JDK 21 via SDKMAN!, Android SDK), install APK to devices, manage Android emulators, and clone ArcSphere Android repository. Supports cloning arc-sphere-android repo, environment setup, device/emulator installation, APK deployment. No sudo required.
allowed-tools: Bash, Read
---

# Android Development Environment Setup & APK Installation

This skill helps you with Android development tasks on macOS.

## What it does

### Repository Clone
1. **Clones** ArcSphere Android repository (arc-sphere-android)
2. **Pre-checks** SSH access to GitHub before attempting clone
3. **Falls back** to HTTPS if SSH not available
4. **Supports** non-interactive mode (`--auto`) for AI agents

### Environment Setup
1. **Diagnoses** your current system
2. **Installs** missing components:
   - **SDKMAN!** (if not present)
   - **Eclipse Temurin JDK 21** via SDKMAN! (no sudo required)
   - **Android Command Line Tools** via Homebrew
   - **Android SDK** components (platform-tools, build-tools, platforms)
3. **Configures** environment variables (JAVA_HOME via SDKMAN!, ANDROID_HOME)

### APK Installation
1. **Checks** connected Android devices with detailed info
2. **Validates** device authorization (USB debugging)
3. **Installs** APK to device with detailed progress
4. **Launches** app automatically (optional)
5. **Provides** troubleshooting guidance in Chinese

### Device Management
1. **Scans** for connected Android devices
2. **Shows** detailed device information (model, Android version, battery, storage)
3. **Validates** USB debugging authorization
4. **Provides** step-by-step setup guide in Chinese

### Emulator Management
1. **Installs** Android Emulator components
2. **Detects** system architecture (ARM64/x86_64) for optimal performance
3. **Downloads** appropriate system images (API 34/33)
4. **Creates** optimized AVD (Android Virtual Device)
5. **Warns** about potential performance issues
6. **Recommends** using real devices for better performance

## Safety features

- ✅ Idempotent (safe to run multiple times)
- ✅ Preserves existing configuration
- ✅ Automatic backup before changes
- ✅ Detailed logging
- ✅ **No sudo required** for JDK installation (uses SDKMAN!)
- ✅ Supports multiple JDK versions side-by-side

## Usage

When you invoke this skill, Claude will:

1. Run the diagnostic script to show you what's installed
2. Ask for your confirmation
3. Run the installation script if you approve
4. Show you the results and next steps

## Implementation

The skill uses pre-written bash scripts located in `scripts/`:
- `scripts/test.sh` - Diagnostic tests for environment
- `scripts/setup.sh` - Environment installation (now includes optional emulator setup)
- `scripts/check-device.sh` - Check connected Android devices
- `scripts/install.sh` - APK installation to devices
- `scripts/install-emulator.sh` - Emulator installation and management
- `scripts/clone-repo.sh` - Clone ArcSphere Android repository (supports `--auto` for non-interactive mode)

## Instructions for Claude

### For Environment Setup

When the user wants to set up the development environment:

1. First, run the diagnostic script:
```bash
bash scripts/test.sh
```

2. Show the user the diagnostic results.

3. Ask the user if they want to proceed with installation.

4. If confirmed, run the installation script:
```bash
bash scripts/setup.sh
```

5. After installation completes, remind the user to:
```bash
source ~/.zshrc
# or restart their terminal
```

6. Optionally verify the installation:
```bash
java -version
echo $JAVA_HOME
echo $ANDROID_HOME
```

### For Device Check

When the user wants to check connected devices:

1. Run the device check script:
```bash
bash scripts/check-device.sh
```

The script will:
- Start ADB server
- Scan for all connected devices
- Show detailed information for each device:
  - Device ID
  - Manufacturer and model
  - Android version and API level
  - Build fingerprint
  - Available storage
  - Battery level
- Display authorization status
- Provide troubleshooting guidance if needed

### For APK Installation

When the user wants to install an APK to a device:

1. Ensure an APK file path is provided or find the latest built APK:
```bash
# Find latest develop debug APK
ls -t app/build/outputs/apk/develop/debug/*.apk | head -1

# Or production release
ls -t app/build/outputs/apk/production/release/*.apk | head -1
```

2. Run the install script with the APK path:
```bash
bash scripts/install.sh <path_to_apk>
```

The script will:
- Check for connected devices
- Show device information (model, Android version)
- Install the APK with progress
- Offer to launch the app automatically
- Provide troubleshooting help if issues occur

### For Emulator Installation

When the user wants to install or manage Android emulators:

**IMPORTANT**: Always show the performance warning before emulator installation.

1. To install emulator (standalone):
```bash
bash scripts/install-emulator.sh install
```

This will:
- Display performance warning: **"⚠️ Android 模拟器可能会卡顿"**
- Ask for user confirmation
- Detect system architecture (ARM64 for Apple Silicon, x86_64 for Intel)
- Install Android Emulator package
- Download appropriate system image
- Create default AVD named "ArcSphere_Emulator"
- Apply performance optimizations

2. To list available emulators:
```bash
bash scripts/install-emulator.sh list
```

3. To start an emulator:
```bash
bash scripts/install-emulator.sh start ArcSphere_Emulator
```

**Performance Recommendations**:
- **Always recommend using real devices first** - better performance and more accurate testing
- Emulator is only recommended when:
  - No physical device available
  - Testing multiple Android versions
  - Automated testing scenarios
- Apple Silicon Macs perform better with ARM system images
- Minimum requirements: 8GB RAM, 10GB disk space

**During setup.sh execution**:
- The script will prompt user to install emulator as Step 4 (optional)
- Shows warning about potential performance issues
- User can skip and install later using standalone script

### For Repository Clone

When the user wants to clone the ArcSphere Android repository:

**IMPORTANT**: Always use `--auto` flag when running from Claude Code to avoid interactive prompts.

1. Clone the repository (non-interactive mode for Claude Code):
```bash
bash scripts/clone-repo.sh --auto
```

2. Clone to a custom location:
```bash
bash scripts/clone-repo.sh --auto ~/my-projects/arc-sphere
```

3. Interactive mode (for human users in terminal):
```bash
bash scripts/clone-repo.sh
```

The script will:
- Pre-check SSH access to GitHub (avoids blind clone attempts)
- Use SSH if available, otherwise fall back to HTTPS
- Skip credential prompts in `--auto` mode (relies on git credential helper)
- Create parent directories if needed
- Report success/failure with clear guidance

**Default clone location**: `~/workspace/arc-sphere-android`

**Authentication behavior**:
- SSH: Automatically uses configured SSH keys
- HTTPS: Uses git credential helper (configured via `git config credential.helper`)
- In `--auto` mode, HTTPS clone will fail if no credentials are cached (no interactive prompt)

## Troubleshooting

If issues occur:
- Check the log files (generated at runtime in root directory):
  - `setup.log` - Environment setup log
  - `install.log` - APK installation log
  - `emulator.log` - Emulator installation log
  - `emulator_<avd_name>.log` - Emulator runtime log
- Configuration backups are in: `.backups/`
- Refer to the detailed usage guide: `docs/USAGE.md`
- For APK installation issues, the script provides detailed Chinese guidance
- For emulator performance issues, always recommend using real devices as the primary option
