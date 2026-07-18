---
name: custom-review
description: Run a custom read-only Claude Code review on arbitrary files or questions (not limited to git diffs)
---

Run a custom Claude review. Pass `$ARGUMENTS` as flags, e.g.
`--prompt-file /tmp/prompt.md --output /abs/path/review.md --cwd /path/to/repo`
or a short inline question via `--prompt "..."`.

Run the following Bash command and show the full output. Do not modify any files.

```bash
PLUGIN_ROOT="${KIMI_PLUGIN_ROOT:-${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/kimi-plugin-cc}"
SCRIPT="$PLUGIN_ROOT/scripts/claude-review.mjs"
if [ ! -f "$SCRIPT" ]; then
  echo "❌ Plugin script not found at $SCRIPT. Is kimi-plugin-cc installed?" >&2
  exit 1
fi
REVIEW_ARGS="$ARGUMENTS" node "$SCRIPT" custom-review
```
