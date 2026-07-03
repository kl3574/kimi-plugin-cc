---
name: setup
description: Check Claude CLI installation and authentication
---

Run the following Bash command and report the result:

```bash
PLUGIN_ROOT="${KIMI_PLUGIN_ROOT:-${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/kimi-plugin-cc}"
node "$PLUGIN_ROOT/scripts/claude-review.mjs" setup
```
