#!/bin/bash

# Script to retrieve git diff in various scenarios
# Usage:
#   ./get_diff.sh                    # Get all uncommitted changes (working + staged)
#   ./get_diff.sh --staged           # Get only staged changes
#   ./get_diff.sh --branch <branch>  # Compare current branch with specified branch
#   ./get_diff.sh --commit <commit>  # Get changes from specific commit

set -e

MODE="working"
TARGET=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --staged)
            MODE="staged"
            shift
            ;;
        --branch)
            MODE="branch"
            TARGET="$2"
            shift 2
            ;;
        --commit)
            MODE="commit"
            TARGET="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Execute based on mode
case $MODE in
    working)
        echo "# Getting all uncommitted changes (working + staged)"
        git diff HEAD
        ;;
    staged)
        echo "# Getting staged changes only"
        git diff --staged
        ;;
    branch)
        if [ -z "$TARGET" ]; then
            echo "Error: --branch requires a branch name"
            exit 1
        fi
        echo "# Comparing with branch: $TARGET"
        git diff "$TARGET"...HEAD
        ;;
    commit)
        if [ -z "$TARGET" ]; then
            echo "Error: --commit requires a commit hash"
            exit 1
        fi
        echo "# Getting changes from commit: $TARGET"
        git show "$TARGET"
        ;;
esac
