---
name: review
description: Run a read-only Claude Code review on current changes
---

Run a Claude review. Pass `$ARGUMENTS` to set optional flags like `--base main` or `--focus "error handling"`.

Run the following Bash command and show the full output. Do not modify any files.

```bash
PLUGIN_ROOT="${KIMI_PLUGIN_ROOT:-${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/kimi-plugin-cc}"
node "$PLUGIN_ROOT/scripts/claude-review.mjs" review "$ARGUMENTS"
```
