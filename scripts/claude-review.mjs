#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const USAGE = `Usage: claude-review.mjs <setup|review|adversarial-review> [--base <ref>] [--focus <text>]`;

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
}

function findGitRoot(cwd = process.cwd()) {
  const result = run('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function getDiff(base, cwd) {
  const args = ['diff', '--no-color'];
  if (base) {
    args.push(`${base}...HEAD`);
  }
  const result = run('git', args, { cwd });
  if (result.status !== 0) {
    throw new Error(`git diff failed: ${result.stderr}`);
  }
  return result.stdout;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0];
  const options = { base: null, focus: '' };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--base' && i + 1 < args.length) {
      options.base = args[++i];
    } else if (args[i] === '--focus' && i + 1 < args.length) {
      options.focus = args[++i];
    } else if (args[i].startsWith('--base=')) {
      options.base = args[i].slice(7);
    } else if (args[i].startsWith('--focus=')) {
      options.focus = args[i].slice(8);
    }
  }
  return { command, options };
}

function claudeOnPath() {
  const result = run('which', ['claude']);
  return result.status === 0 && result.stdout.trim().length > 0;
}

function claudeVersion() {
  const result = run('claude', ['--version']);
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function claudeAuthOk() {
  const result = run('claude', ['auth', 'status']);
  return result.status === 0;
}

function setup() {
  if (!claudeOnPath()) {
    console.log('❌ Claude CLI not found on PATH. Install from https://claude.ai/code');
    process.exit(1);
  }
  const version = claudeVersion();
  console.log(`✅ Claude CLI found: ${version}`);
  if (!claudeAuthOk()) {
    console.log('❌ Claude CLI is not authenticated. Run `claude auth login`.');
    process.exit(1);
  }
  console.log('✅ Claude CLI is authenticated.');
}

function review({ base, focus, adversarial = false }) {
  const gitRoot = findGitRoot();
  if (!gitRoot) {
    console.error('❌ Not inside a git repository.');
    process.exit(1);
  }

  if (!claudeOnPath()) {
    console.error('❌ Claude CLI not found on PATH. Run `claude-setup` first.');
    process.exit(1);
  }

  let diff;
  try {
    diff = getDiff(base, gitRoot);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  if (!diff.trim()) {
    console.log('No changes to review.');
    return;
  }

  const maxDiffChars = 120000;
  let truncated = false;
  if (diff.length > maxDiffChars) {
    diff = diff.slice(0, maxDiffChars) + '\n\n[diff truncated]';
    truncated = true;
  }

  const systemPrompt = adversarial
    ? `You are a senior staff engineer doing a read-only adversarial code review. Challenge design decisions, trade-offs, hidden assumptions, and failure modes. Be constructive but skeptical. Categorize findings as Critical, Important, or Minor. For each finding include severity, file:line, evidence, why it matters, and a recommended fix. End with an overall verdict.`
    : `You are a senior staff engineer doing a read-only code review. Categorize findings as Critical, Important, or Minor. For each finding include severity, file:line, evidence, why it matters, and a recommended fix. End with an overall verdict.`;

  const userPrompt = [
    'Review the following git diff.',
    base ? `Base ref: ${base}` : 'Reviewing current uncommitted changes.',
    focus ? `Focus: ${focus}` : '',
    '',
    '```diff',
    diff,
    '```',
  ].join('\n');

  const claudeArgs = [
    '-p',
    userPrompt,
    '--output-format', 'text',
    '--bare',
    '--permission-mode', 'auto',
    '--system-prompt', systemPrompt,
  ];

  const result = run('claude', claudeArgs, { cwd: gitRoot, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    console.error('❌ Claude review failed.');
    if (result.stderr) console.error(result.stderr);
    process.exit(1);
  }

  if (truncated) {
    console.log('⚠️ Diff was truncated before sending to Claude.\n');
  }
  console.log(result.stdout);
}

const { command, options } = parseArgs(process.argv);

switch (command) {
  case 'setup':
    setup();
    break;
  case 'review':
    review(options);
    break;
  case 'adversarial-review':
    review({ ...options, adversarial: true });
    break;
  default:
    console.error(USAGE);
    process.exit(1);
}
