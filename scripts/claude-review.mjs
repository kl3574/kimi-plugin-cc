#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const USAGE = `Usage: claude-review.mjs <setup|review|adversarial-review> [--base <ref>] [--focus <text>]`;
const LARGE_BUFFER = 64 * 1024 * 1024;

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: LARGE_BUFFER,
    ...opts,
  });
}

function runGit(args, opts = {}) {
  const { env: callerEnv, ...restOpts } = opts;
  return run('git', args, {
    env: { ...process.env, LC_ALL: 'C', ...callerEnv },
    ...restOpts,
  });
}

function findGitRoot(cwd = process.cwd()) {
  const result = runGit(['rev-parse', '--show-toplevel'], { cwd });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function hasHead(cwd) {
  const result = runGit(['rev-parse', '--verify', 'HEAD'], { cwd });
  return result.status === 0;
}

function getDiff(base, cwd) {
  if (base) {
    const result = runGit(['diff', '--no-color', `${base}...HEAD`], { cwd });
    if (result.status !== 0) {
      throw new Error(`git diff failed: ${result.stderr || result.stdout || 'unknown error'}`);
    }
    return result.stdout;
  }
  if (!hasHead(cwd)) {
    const result = runGit(['diff', '--cached', '--no-color'], { cwd });
    if (result.status !== 0) {
      throw new Error(`git diff failed: ${result.stderr || result.stdout || 'unknown error'}`);
    }
    return result.stdout;
  }
  // Combine staged and unstaged diffs separately so that working-tree changes
  // that cancel out staged changes do not hide the staged patch.
  const unstaged = runGit(['diff', '--no-color'], { cwd }).stdout;
  const staged = runGit(['diff', '--cached', '--no-color'], { cwd }).stdout;
  return [staged, unstaged].filter(Boolean).join('\n');
}

function splitArgsString(s) {
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let token = '';
    if (s[i] === '"' || s[i] === "'") {
      const quote = s[i++];
      while (i < s.length && s[i] !== quote) token += s[i++];
      if (i < s.length) i++;
    } else {
      while (i < s.length && !/\s/.test(s[i])) token += s[i++];
    }
    tokens.push(token);
  }
  return tokens;
}

function normalizeArgv(argv) {
  let args = argv.slice(2);
  if (args.length === 1 && args[0].length > 0) {
    args = splitArgsString(args[0]);
  } else if (args.length === 1 && args[0].length === 0) {
    args = [];
  }
  return args;
}

function parseArgs(argv) {
  const args = normalizeArgv(argv);
  const command = args[0];
  const options = { base: null, focus: '', unknown: [], positional: [] };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--base') {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
        throw new Error('--base requires a value');
      }
      options.base = args[++i];
    } else if (args[i] === '--focus') {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
        throw new Error('--focus requires a value');
      }
      options.focus = args[++i];
    } else if (args[i].startsWith('--base=')) {
      const value = args[i].slice(7);
      if (!value) throw new Error('--base requires a value');
      options.base = value;
    } else if (args[i].startsWith('--focus=')) {
      const value = args[i].slice(8);
      if (!value) throw new Error('--focus requires a value');
      options.focus = value;
    } else if (args[i].startsWith('-')) {
      options.unknown.push(args[i]);
    } else {
      options.positional.push(args[i]);
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

function review({ base, focus, adversarial = false, unknown = [], positional = [] }) {
  if (unknown.length) {
    console.error(`❌ Unknown option(s): ${unknown.join(', ')}`);
    process.exit(1);
  }

  if (adversarial && !focus && positional.length) {
    focus = positional.join(' ');
  } else if (positional.length) {
    console.error(`❌ Unexpected positional argument(s): ${positional.join(' ')}`);
    process.exit(1);
  }

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
    ? `You are a senior staff engineer doing a read-only adversarial code review.${focus ? ` Focus: ${focus}` : ''} Challenge design decisions, trade-offs, hidden assumptions, and failure modes. Be constructive but skeptical. Categorize findings as Critical, Important, or Minor. For each finding include severity, file:line, evidence, why it matters, and a recommended fix. End with an overall verdict.`
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

let parsed;
try {
  parsed = parseArgs(process.argv);
} catch (err) {
  console.error(`❌ ${err.message}`);
  console.error(USAGE);
  process.exit(1);
}

const { command, options } = parsed;

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
