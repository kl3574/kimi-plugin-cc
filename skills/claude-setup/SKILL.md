---
name: claude-setup
description: Check that the Claude Code CLI is installed and authenticated
---

# Claude Setup

Use this skill when the user wants to verify Claude Code CLI readiness.

## Steps

1. Run the helper script:
   ```bash
   PLUGIN_ROOT="${KIMI_PLUGIN_ROOT:-${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/kimi-plugin-cc}"
   node "$PLUGIN_ROOT/scripts/claude-review.mjs" setup
   ```
2. Report the result to the user, including any missing CLI or authentication issues.

## Output

The setup command prints a status line for each check (e.g., CLI found, authenticated) or a clear error describing what is missing.
