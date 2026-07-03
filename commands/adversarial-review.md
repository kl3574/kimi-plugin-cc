---
name: adversarial-review
description: Run a steerable adversarial Claude Code review
---

Run a Claude adversarial review. Pass `$ARGUMENTS` for optional flags and focus text.

Run the following Bash command and show the full output. Do not modify any files.

```bash
PLUGIN_ROOT="${KIMI_PLUGIN_ROOT:-${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/kimi-plugin-cc}"
SCRIPT="$PLUGIN_ROOT/scripts/claude-review.mjs"
if [ ! -f "$SCRIPT" ]; then
  echo "❌ Plugin script not found at $SCRIPT. Is kimi-plugin-cc installed?" >&2
  exit 1
fi
REVIEW_ARGS="$ARGUMENTS" node "$SCRIPT" adversarial-review
```
