# Kimi Plugin CC

A Kimi Code plugin that delegates read-only code review to the local Claude Code CLI. This is the Kimi-side mirror of `codex-plugin-cc`.

## Install

From GitHub (recommended):

```text
/plugins install https://github.com/kl3574/kimi-plugin-cc
/reload
```

Or clone manually into your Kimi Code plugins directory (replace `~/.kimi-code` with your `$KIMI_CODE_HOME` if you changed it):

```bash
git clone https://github.com/kl3574/kimi-plugin-cc.git ~/.kimi-code/plugins/managed/kimi-plugin-cc
```

Then restart Kimi Code or run `/reload`.

### Custom Claude CLI location

If your Claude CLI binary is not named `claude` on PATH, set `CC_CLAUDE_BIN`:

```bash
export CC_CLAUDE_BIN=/path/to/claude
```

## Usage

```text
/kimi-plugin-cc:setup
/kimi-plugin-cc:doctor
/kimi-plugin-cc:doctor --probe-runtime
/kimi-plugin-cc:review
/kimi-plugin-cc:review --base main
/kimi-plugin-cc:review --base main --focus "security"
/kimi-plugin-cc:review --path src/utils.js
/kimi-plugin-cc:review --path src --focus "error handling"
/kimi-plugin-cc:adversarial-review --base main challenge the error handling
```

Or use skills directly:

```text
Use the skill claude-review
Use the skill claude-adversarial-review with base main
```

## How It Works

The plugin ships four skills and four slash commands. Each command is a thin wrapper over the corresponding skill. The skills instruct Kimi Code to run `scripts/claude-review.mjs`, which:

1. Verifies the local `claude` CLI is installed and authenticated.
2. Collects `git diff` (unstaged) and `git diff --cached` (staged) for working-tree changes, plus untracked files rendered as new-file diffs. Untracked files are included only in the default working-tree review; when `--base` is given, it computes `git merge-base <base> HEAD` and reviews only the committed changes on the current branch since that merge-base (`<merge-base>..HEAD`). When `--path` is given, the diff is restricted to that file or directory.
3. Builds a reviewer prompt.
4. Spawns `claude -p --output-format text --bare --permission-mode plan`.
5. Returns Claude's findings to the Kimi Code session.

## Diagnostics

Run `/kimi-plugin-cc:doctor` to check:

- Plugin-local environment (Node.js version, git repo, writable directories).
- Whether `claude` is on PATH, its version, and authentication status.
- Proxy environment variables and proxy socket reachability.
- Direct connectivity to `api.anthropic.com:443`.

Add `--probe-runtime` to send a minimal prompt to Claude and confirm the API path works end-to-end. If the external CLI fails, the plugin prints the real CLI exit code/signal and stderr and exits without fabricating a review.

## Verification

- Plugin manifest: valid JSON, `skills` and `commands` paths present.
- Helper script: tested with `setup`, `review`, `adversarial-review`, `--base <ref>`, and `--focus <text>`.
- Claude CLI invoked with `--bare --permission-mode plan --output-format text`.
- Review is read-only; no write tools are passed to Claude.
- Smoke test in `/tmp/review-test` caught the intentional `add` → `a-b` bug and produced structured Critical findings.
- Boundary tests passed:
  - Non-git directory → clear error, exit 1.
  - Empty diff → "No changes to review.", exit 0.
  - Invalid base ref → clear English git error, exit 1.
  - Staged changes in a repo with history → reviewed via `git diff --cached`.
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
- Untracked files that have not been staged are included as synthetic new-file diffs, up to 500 KB per file and 1 MB total across all untracked files.
- Skills and commands resolve the helper script via `PLUGIN_ROOT` using `KIMI_PLUGIN_ROOT`, `KIMI_CODE_HOME`, or the default `~/.kimi-code/plugins/managed/kimi-plugin-cc` path.
- This is a v0.1 local prototype. Compared to the upstream `codex-plugin-cc`, the following are not yet implemented:
  - `--background` / `--wait` flags for non-blocking reviews.
  - `rescue`, `status`, `result`, and `cancel` commands for delegating work and managing background jobs.
  - The stop review gate (`--enable-review-gate` / `--disable-review-gate`).
  - Automatic installation of the `claude` CLI during setup.
- After registering the plugin, run `/reload` or `/new` in your current Kimi Code session to load slash commands and skills.
