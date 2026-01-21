#!/usr/bin/env bash
# Clone ArcSphere Android Repository
# Simple, focused, idempotent - one tool, one job

set -euo pipefail

# ============================================================================
# Configuration
# ============================================================================

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly LOG_FILE="${SCRIPT_DIR}/clone-repo.log"

# Repository configuration
readonly REPO_SSH="git@github.com:ArcBlock/arc-sphere-android.git"
readonly REPO_HTTPS="https://github.com/ArcBlock/arc-sphere-android.git"
readonly DEFAULT_TARGET_DIR="${HOME}/workspace/arc-sphere-android"

# Mode: auto (non-interactive) or interactive
AUTO_MODE=false

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
# Core Functions
# ============================================================================

check_git() {
    if ! command -v git &>/dev/null; then
        log_error "Git is not installed"
        echo ""
        echo "Please install Git first:"
        echo "  brew install git"
        return 1
    fi
    return 0
}

# Pre-check SSH access to GitHub (faster than blind clone attempt)
check_ssh_access() {
    log "Checking SSH access to GitHub..."

    # Test SSH connection with 5 second timeout
    # ssh -T returns exit code 1 for successful auth (GitHub's behavior)
    if timeout 5 ssh -T git@github.com 2>&1 | grep -q "successfully authenticated"; then
        log "✓ SSH access confirmed"
        return 0
    fi

    log_warn "SSH access not available"
    return 1
}

check_repository() {
    local target_dir="${1:-$DEFAULT_TARGET_DIR}"

    if [[ -d "$target_dir/.git" ]]; then
        log "Repository already exists at: $target_dir"

        # Verify it's the correct repository
        if cd "$target_dir" && git remote get-url origin &>/dev/null; then
            local remote_url=$(git remote get-url origin)
            log "Remote URL: $remote_url"
            return 0
        fi
    fi

    return 1
}

clone_repository() {
    local target_dir="${1:-$DEFAULT_TARGET_DIR}"

    log "=========================================="
    log "Cloning ArcSphere Android Repository"
    log "=========================================="
    log "Target: $target_dir"
    log "Mode: $( [[ "$AUTO_MODE" == true ]] && echo "auto (non-interactive)" || echo "interactive" )"
    log ""

    # Ensure Git is available
    check_git || return 1

    # Check if already cloned
    if check_repository "$target_dir"; then
        log "Repository already cloned, nothing to do"
        return 0
    fi

    # Create parent directory if needed
    local parent_dir=$(dirname "$target_dir")
    if [[ ! -d "$parent_dir" ]]; then
        log "Creating directory: $parent_dir"
        mkdir -p "$parent_dir"
    fi

    # Pre-check SSH access before attempting clone
    local use_ssh=false
    if check_ssh_access; then
        use_ssh=true
    fi

    # Clone using the best available method
    if [[ "$use_ssh" == true ]]; then
        log "Cloning via SSH..."
        log "URL: $REPO_SSH"
        echo ""

        if git clone "$REPO_SSH" "$target_dir"; then
            log "✓ Successfully cloned via SSH"
            log "Location: $target_dir"
            return 0
        else
            log_error "SSH clone failed unexpectedly"
            # Fall through to HTTPS
        fi
    fi

    # Use HTTPS (either SSH not available or SSH clone failed)
    log "Cloning via HTTPS..."
    log "URL: $REPO_HTTPS"
    echo ""

    if [[ "$AUTO_MODE" != true ]]; then
        echo -e "${YELLOW}Note:${NC} HTTPS requires GitHub credentials:"
        echo "  • Username: Your GitHub username"
        echo "  • Password: Personal Access Token (NOT your login password)"
        echo ""
        echo "How to get a Personal Access Token:"
        echo "  1. Visit https://github.com/settings/tokens"
        echo "  2. Click 'Generate new token' → 'Generate new token (classic)'"
        echo "  3. Select 'repo' scope"
        echo "  4. Generate and copy the token"
        echo ""
        echo "Press Ctrl+C to cancel, or Enter to continue..."
        read -r
    fi

    if git clone "$REPO_HTTPS" "$target_dir"; then
        log "✓ Successfully cloned via HTTPS"
        log "Location: $target_dir"
        return 0
    fi

    log_error "✗ Clone failed"
    echo ""
    echo "Troubleshooting:"
    echo "  1. Network: Check if you can access GitHub"
    echo "  2. Repository access: Confirm your account has permission"
    echo "  3. Credentials: HTTPS requires Personal Access Token, not login password"
    echo "  4. SSH key: If using SSH, configure your SSH key first"
    echo ""
    echo "Configure SSH key:"
    echo "  ssh-keygen -t ed25519 -C \"your_email@example.com\""
    echo "  cat ~/.ssh/id_ed25519.pub  # Copy public key to GitHub Settings → SSH Keys"
    return 1
}

# ============================================================================
# Main
# ============================================================================

usage() {
    echo "Usage: $(basename "$0") [OPTIONS] [TARGET_DIR]"
    echo ""
    echo "Clone ArcSphere Android repository"
    echo ""
    echo "Options:"
    echo "  --auto, -a    Non-interactive mode (for CI/AI agents)"
    echo "  --help, -h    Show this help message"
    echo ""
    echo "Arguments:"
    echo "  TARGET_DIR    Clone destination (default: ~/workspace/arc-sphere-android)"
    echo ""
    echo "Examples:"
    echo "  $(basename "$0")                    # Interactive clone to default location"
    echo "  $(basename "$0") --auto             # Non-interactive clone (for Claude Code)"
    echo "  $(basename "$0") --auto ~/projects  # Non-interactive clone to custom location"
}

main() {
    local target_dir="$DEFAULT_TARGET_DIR"

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --auto|-a)
                AUTO_MODE=true
                shift
                ;;
            --help|-h)
                usage
                return 0
                ;;
            -*)
                log_error "Unknown option: $1"
                usage
                return 1
                ;;
            *)
                target_dir="$1"
                shift
                ;;
        esac
    done

    log "Started at: $(date)"
    log ""

    if clone_repository "$target_dir"; then
        log ""
        log "=========================================="
        log "Repository cloned successfully!"
        log "=========================================="
        log "Location: $target_dir"
        log ""
        log "Next steps:"
        log "  cd $target_dir"
        log "  # Start development"
        return 0
    else
        log_error "Repository clone failed"
        return 1
    fi
}

# Run if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
