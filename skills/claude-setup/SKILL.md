---
name: claude-setup
description: Verify that Claude Code CLI is installed and authenticated before running Claude reviews from Kimi Code
---

# Claude Setup

Run the setup check and report the result to the user.

```bash
node /home/lkx/.kimi-code/plugins/managed/kimi-plugin-cc/scripts/claude-review.mjs setup
```

If it fails, guide the user to install Claude Code from https://claude.ai/code and run `claude auth login`.

Optional: for convenience, create a symlink so other skills can call `claude-review-kimi`:

```bash
ln -sf /home/lkx/.kimi-code/plugins/managed/kimi-plugin-cc/scripts/claude-review.mjs ~/.local/bin/claude-review-kimi
```
