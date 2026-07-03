---
name: claude-review
description: Run a read-only Claude Code review on the current git changes from inside Kimi Code
---

# Claude Review

Use this skill when the user wants an independent Claude Code review of their current work.

## Steps

1. Determine what the user wants to review:
   - Uncommitted changes (default)
   - A branch compared to a base ref (e.g., `main`)
   - Optionally, a focus area such as `security` or `error handling`
2. Build the helper command with the appropriate flags:
   ```bash
   PLUGIN_ROOT="${KIMI_PLUGIN_ROOT:-${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/kimi-plugin-cc}"
   node "$PLUGIN_ROOT/scripts/claude-review.mjs" review <FLAGS>
   ```
   Examples:
   - `node "$PLUGIN_ROOT/scripts/claude-review.mjs" review`
   - `node "$PLUGIN_ROOT/scripts/claude-review.mjs" review --base main`
   - `node "$PLUGIN_ROOT/scripts/claude-review.mjs" review --focus "security"`
   - `node "$PLUGIN_ROOT/scripts/claude-review.mjs" review --base main --focus "error handling"`
   - `node "$PLUGIN_ROOT/scripts/claude-review.mjs" review --path src/utils.js`
   - `node "$PLUGIN_ROOT/scripts/claude-review.mjs" review --path src`
3. Run the command and show the full output. Do not modify any files.
4. Present the findings to the user, preserving severity headings.
5. Do not apply any fixes unless the user explicitly asks in a separate step.

## Output

Claude returns a markdown report with Critical / Important / Minor findings and an overall verdict.
