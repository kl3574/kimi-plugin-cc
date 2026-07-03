# Kimi Plugin CC

A Kimi Code plugin that delegates read-only code review to the local Claude Code CLI. This is the Kimi-side mirror of `codex-plugin-cc`.

## Install

From a local path:

```text
/plugins install /home/lkx/kimi-plugin-cc
/reload
```

From GitHub:

```text
/plugins install https://github.com/kl3574/kimi-plugin-cc
/reload
```

## Usage

```text
/kimi-plugin-cc:setup
/kimi-plugin-cc:review
/kimi-plugin-cc:review --base main
/kimi-plugin-cc:review --base main --focus "security"
/kimi-plugin-cc:adversarial-review --base main challenge the error handling
```

Or use skills directly:

```text
Use the skill claude-review
Use the skill claude-adversarial-review with base main
```

## How It Works

The plugin ships three skills and three slash commands. Each command is a thin wrapper over the corresponding skill. The skills instruct Kimi Code to run `scripts/claude-review.mjs`, which:

1. Verifies the local `claude` CLI is installed and authenticated.
2. Collects `git diff HEAD` for uncommitted/staged changes, or `git diff <base>...HEAD` when `--base` is given.
3. Builds a reviewer prompt.
4. Spawns `claude -p --output-format text --bare --permission-mode auto`.
5. Returns Claude's findings to the Kimi Code session.

## Verification

- Plugin manifest: valid JSON, `skills` and `commands` paths present.
- Helper script: tested with `setup`, `review`, `adversarial-review`, `--base <ref>`, and `--focus <text>`.
- Claude CLI invoked with `--bare --permission-mode auto --output-format text`.
- Review is read-only; no write tools are passed to Claude.
- Smoke test in `/tmp/review-test` caught the intentional `add` → `a-b` bug and produced structured Critical findings.
- Boundary tests passed:
  - Non-git directory → clear error, exit 1.
  - Empty diff → "No changes to review.", exit 0.
  - Invalid base ref → clear English git error, exit 1.
  - Staged changes in a repo with history → reviewed via `git diff HEAD`.
  - Staged changes in a brand-new repo (no commits yet) → reviewed via `git diff --cached`.
  - Large diff (>1 MB, up to tens of MB) → collected without buffer overflow, truncated to 120 k chars, and reviewed successfully.
  - `--base` / `--focus` without values → clear error, exit 1.
  - Unknown flags or unexpected positional args for `review` → clear error, exit 1.
  - Positional focus text for `adversarial-review` (e.g. `... challenge the file naming`) → treated as focus.
- The plugin is registered in `~/.kimi-code/plugins/installed.json`; a fresh `kimi -p` session loaded the skills.

## Limitations

- Requires a local git repository.
- Requires `claude` on PATH and authenticated.
- Very large diffs are truncated to 120,000 characters before sending to Claude.
- Untracked files that have not been staged are not included in the review.
- Skills and commands currently reference the helper script by absolute path `/home/lkx/.kimi-code/plugins/managed/kimi-plugin-cc/scripts/claude-review.mjs`. If you move or copy the plugin elsewhere, reinstall from the new path.
- This is a v0.1 local prototype. Compared to the upstream `codex-plugin-cc`, the following are not yet implemented:
  - `--background` / `--wait` flags for non-blocking reviews.
  - `rescue`, `status`, `result`, and `cancel` commands for delegating work and managing background jobs.
  - The stop review gate (`--enable-review-gate` / `--disable-review-gate`).
  - Automatic installation of the `claude` CLI during setup.
- After registering the plugin, run `/reload` or `/new` in your current Kimi Code session to load slash commands and skills.
