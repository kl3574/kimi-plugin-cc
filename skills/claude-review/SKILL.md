---
name: claude-review
description: Run a read-only Claude Code review on the current git changes from inside Kimi Code
---

# Claude Review

Use this skill when the user wants an independent Claude Code review of their current work.

## Steps

1. Determine whether the user wants to review:
   - Uncommitted changes (default)
   - A branch compared to a base ref (e.g., `main`)
2. Run the helper script:
   ```bash
   node /home/lkx/.kimi-code/plugins/managed/kimi-plugin-cc/scripts/claude-review.mjs review
   ```
   or with a base ref:
   ```bash
   node /home/lkx/.kimi-code/plugins/managed/kimi-plugin-cc/scripts/claude-review.mjs review --base main
   ```
3. Present Claude's findings to the user, preserving severity headings.
4. Do not apply any fixes unless the user explicitly asks in a separate step.

## Output

Claude returns a markdown report with Critical / Important / Minor findings and an overall verdict.
