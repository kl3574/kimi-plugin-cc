---
name: setup
description: Check Claude CLI installation and authentication
---

Run the following Bash command and report the result:

```bash
PLUGIN_ROOT="${KIMI_PLUGIN_ROOT:-${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/kimi-plugin-cc}"
SCRIPT="$PLUGIN_ROOT/scripts/claude-review.mjs"
if [ ! -f "$SCRIPT" ]; then
  echo "❌ Plugin script not found at $SCRIPT. Is kimi-plugin-cc installed?" >&2
  exit 1
fi
node "$SCRIPT" setup
```
