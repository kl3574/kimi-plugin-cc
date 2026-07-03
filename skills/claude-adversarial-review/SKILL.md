---
name: claude-adversarial-review
description: Run a steerable adversarial Claude Code review that challenges design decisions from inside Kimi Code
---

# Claude Adversarial Review

Use this skill when the user wants Claude to challenge the design, trade-offs, or assumptions behind the current changes.

## Steps

1. Identify any focus area the user provided (e.g., "challenge the retry logic").
2. Run the helper script with the focus:
   ```bash
   node /home/lkx/.kimi-code/plugins/managed/kimi-plugin-cc/scripts/claude-review.mjs adversarial-review --base main --focus "challenge the retry logic"
   ```
3. Present Claude's findings.
4. Do not apply fixes automatically.
