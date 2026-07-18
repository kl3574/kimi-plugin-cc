---
description: Run a custom read-only Claude Code review on arbitrary files or questions (not limited to git diffs).
---

# Custom Claude Code Review

Use this skill when the user wants Claude Code to review or analyze arbitrary content that is NOT a git diff — e.g. auditing a design document against a reference paper, reviewing results files, or asking Claude a free-form question with tool access to the repo.

## Steps

1. Determine the review target:
   - A prompt file (`--prompt-file <path>`) for long, carefully-scoped prompts (recommended; prompt is piped via stdin, avoiding argv limits and quoting issues)
   - Inline text (`--prompt <text>` or positional arguments) for short questions
2. Optional flags:
   - `--output <path>` — write the review to a file (always resolved to an absolute path; parent directories are created)
   - `--tools <csv>` — allowed tools (default `Read,Grep,Glob,Bash`; `Edit,Write,NotebookEdit` are always disallowed)
   - `--permission-mode <default|plan|acceptEdits|bypassPermissions>` (default `default`)
   - `--cwd <dir>` — working directory for the review (default: current directory)
   - `--timeout-ms <n>` (default: 300000)
   - `--system-prompt <text>` — override the reviewer persona
   - `--model <m>` — only when the user explicitly asks; custom local model configs break when an unknown model is forced
3. Build and run the helper command:
   ```bash
   PLUGIN_ROOT="${KIMI_PLUGIN_ROOT:-${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/kimi-plugin-cc}"
   node "$PLUGIN_ROOT/scripts/claude-review.mjs" custom-review <FLAGS>
   ```
   Example (document-vs-paper audit):
   ```bash
   node "$PLUGIN_ROOT/scripts/claude-review.mjs" custom-review \
     --prompt-file /tmp/audit_prompt.md \
     --output /abs/path/review.md \
     --cwd /path/to/repo
   ```
4. Show the full output. Do not modify any files unless the user asks in a separate step.

## Notes

- The review is read-only by construction (`Edit/Write/NotebookEdit` disallowed).
- For progress visibility on long reviews, watch the output file grow or use the task panel; plain text output is written when the run completes.
- If the helper exits non-zero, report the failure exactly (exit code and stderr tail are printed) and stop.

ARGUMENTS: $ARGUMENTS
