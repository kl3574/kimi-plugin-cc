#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage: claude-review.mjs <setup|doctor|review|adversarial-review|custom-review> [--base <ref>] [--focus <text>] [--path <file-or-dir>] [--probe-runtime]\n       custom-review: --prompt-file <path> | --prompt <text> [--output <path>] [--tools <csv>] [--permission-mode <mode>] [--model <m>] [--cwd <dir>] [--timeout-ms <n>] [--system-prompt <text>]`;
const LARGE_BUFFER = 64 * 1024 * 1024;
const REVIEW_TIMEOUT_MS = Number(process.env.CC_REVIEW_TIMEOUT_MS) || 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = Number(process.env.CC_PROBE_TIMEOUT_MS) || 10 * 1000;
const KILL_GRACE_MS = 10 * 1000;
const CONNECT_TIMEOUT_MS = Number(process.env.CC_CONNECT_TIMEOUT_MS) || 5000;
const MAX_UNTRACKED_BYTES = Number(process.env.CC_MAX_UNTRACKED_BYTES) || 500 * 1024;
const TOTAL_UNTRACKED_BUDGET_BYTES = Number(process.env.CC_TOTAL_UNTRACKED_BUDGET_BYTES) || 1024 * 1024;
const CLAUDE_BIN = process.env.CC_CLAUDE_BIN || 'claude';

function run(cmd, args, opts = {}) {
  const { input, ...restOpts } = opts;
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    maxBuffer: LARGE_BUFFER,
    input,
    ...restOpts,
  });
}

function runAsync(cmd, args, opts = {}) {
  const { stdin, timeout = REVIEW_TIMEOUT_MS, maxBuffer = LARGE_BUFFER, ...spawnOpts } = opts;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: stdin !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      ...spawnOpts,
    });
    let stdout = '';
    let stderr = '';
    let combinedBytes = 0;
    let killed = false;
    let timedOut = false;
    let killReason = null;
    let killTimer = null;
    let resolved = false;
    const timer = timeout
      ? setTimeout(() => {
          if (timedOut || killed) return;
          timedOut = true;
          killReason = killReason || 'timeout';
          child.kill('SIGTERM');
          if (!killTimer) {
            killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
          }
        }, timeout)
      : null;
    child.stdout.on('data', (data) => {
      if (resolved) return;
      stdout += data.toString();
      combinedBytes += data.length;
      if (combinedBytes > maxBuffer && !killed && !timedOut && !resolved) {
        killed = true;
        killReason = killReason || 'maxBuffer';
        child.kill('SIGTERM');
        if (!killTimer) {
          killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
        }
      }
    });
    child.stderr.on('data', (data) => {
      if (resolved) return;
      stderr += data.toString();
      combinedBytes += data.length;
      if (combinedBytes > maxBuffer && !killed && !timedOut && !resolved) {
        killed = true;
        killReason = killReason || 'maxBuffer';
        child.kill('SIGTERM');
        if (!killTimer) {
          killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
        }
      }
    });
    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code: 1, signal: null, stdout, stderr: `❌ Failed to start ${cmd}: ${err.message}` });
    });
    child.on('close', (code, signal) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (signal === 'SIGKILL') {
        const msg = killReason === 'timeout'
          ? `\n❌ Review timed out after ${timeout / 60000} minutes and was force-killed.`
          : '\n❌ Review was force-killed after output exceeded the maxBuffer limit.';
        resolve({ code: 1, signal: 'SIGKILL', stdout, stderr: stderr + msg });
        return;
      }
      if (timedOut) {
        resolve({ code: 1, signal, stdout, stderr: stderr + `\n❌ Review timed out after ${timeout / 60000} minutes.` });
        return;
      }
      if (signal === 'SIGTERM' && killed) {
        resolve({ code: 1, signal: 'SIGTERM', stdout, stderr: stderr + '\n❌ Output exceeded maxBuffer limit.' });
        return;
      }
      resolve({ code, signal, stdout, stderr });
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
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

function checkGitResult(result, label) {
  if (result.status !== 0) {
    throw new Error(`git ${label} failed: ${result.stderr || result.stdout || result.error?.message || 'unknown error'}`);
  }
}

function getUntrackedFiles(cwd) {
  const result = runGit(['ls-files', '-z', '--others', '--exclude-standard'], { cwd });
  if (result.status !== 0) return [];
  return result.stdout.split('\0').filter(Boolean);
}

function isBinaryContent(buf) {
  if (buf.length === 0) return false;
  if (buf.includes(0)) return true;
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const b = sample[i];
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)) continue;
    nonPrintable += 1;
  }
  return nonPrintable / sample.length > 0.1;
}

function gitBlobHash(content) {
  const header = `blob ${content.length}\0`;
  return crypto.createHash('sha1').update(header).update(content).digest('hex').slice(0, 7);
}

function syntheticNewFileDiff(filePath, relPath) {
  let content;
  try {
    content = fs.readFileSync(filePath);
  } catch (err) {
    return { skipped: true, reason: `read error: ${err.message}` };
  }
  if (isBinaryContent(content)) {
    return { skipped: true, reason: 'binary file' };
  }
  if (content.length === 0) {
    return { skipped: true, reason: 'empty file' };
  }
  const text = content.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n');
  const endsWithNewline = text.endsWith('\n');
  const lineCount = endsWithNewline ? lines.length - 1 : lines.length;
  const hash = gitBlobHash(content);
  const header = [
    `diff --git a/${relPath} b/${relPath}`,
    'new file mode 100644',
    `index 0000000..${hash}`,
    '--- /dev/null',
    `+++ b/${relPath}`,
    `@@ -0,0 +1,${lineCount} @@`,
  ];
  const body = lines.slice(0, lineCount).map((line) => `+${line}`);
  if (!endsWithNewline) {
    body.push('\\ No newline at end of file');
  }
  return { diff: header.concat(body).join('\n') };
}

function getUntrackedFileDiff(cwd, file) {
  return syntheticNewFileDiff(path.resolve(cwd, file), file);
}

function formatUntrackedDiff(cwd, target = null) {
  let files = getUntrackedFiles(cwd);
  if (target && target.relPath !== '.') {
    const rel = target.relPath.replace(/\\/g, '/');
    if (target.targetType === 'file') {
      files = files.filter((f) => f === rel);
    } else {
      const prefix = rel + '/';
      files = files.filter((f) => f.startsWith(prefix));
    }
  }
  if (files.length === 0) return { diff: '', hasRealDiff: false, skipped: [] };
  const parts = [];
  const skipped = [];
  let totalBytes = 0;
  const resolvedCwd = path.resolve(cwd);
  for (const file of files) {
    const fullPath = path.resolve(cwd, file);
    if (!fullPath.startsWith(resolvedCwd + path.sep) && fullPath !== resolvedCwd) {
      skipped.push(`${file} (path traversal)`);
      continue;
    }
    let stat;
    try {
      stat = fs.lstatSync(fullPath);
    } catch {
      skipped.push(`${file} (read error)`);
      continue;
    }
    if (stat.isSymbolicLink()) {
      skipped.push(`${file} (symlink)`);
      continue;
    }
    if (!stat.isFile()) {
      skipped.push(`${file} (not a regular file)`);
      continue;
    }
    if (stat.size > MAX_UNTRACKED_BYTES) {
      skipped.push(`${file} (file too large)`);
      continue;
    }
    let result;
    // Safety net: getUntrackedFileDiff delegates to syntheticNewFileDiff, which
    // handles read errors and returns { skipped }. This catch guards against
    // unexpected errors in diff construction.
    try {
      result = getUntrackedFileDiff(cwd, file);
    } catch (err) {
      skipped.push(`${file} (diff error: ${err.message})`);
      continue;
    }
    if (result.skipped) {
      skipped.push(`${file} (${result.reason})`);
      continue;
    }
    const diffBytes = Buffer.byteLength(result.diff, 'utf8');
    if (totalBytes + diffBytes > TOTAL_UNTRACKED_BUDGET_BYTES) {
      skipped.push(`${file} (total untracked budget exceeded)`);
      continue;
    }
    totalBytes += diffBytes;
    parts.push(result.diff);
  }
  const diff = parts.length > 0 && skipped.length > 0
    ? [...parts, `\n# Skipped untracked files: ${skipped.join(', ')}`].join('\n')
    : parts.join('\n');
  return { diff, hasRealDiff: parts.length > 0, skipped };
}

function getTrackedDiff(base, cwd, target = null) {
  const pathArgs = target && target.relPath !== '.' ? ['--', target.relPath.replace(/\\/g, '/')] : [];
  if (base) {
    const mergeBaseResult = runGit(['merge-base', base, 'HEAD'], { cwd });
    checkGitResult(mergeBaseResult, 'merge-base');
    const mergeBase = mergeBaseResult.stdout.trim();
    if (!mergeBase) {
      throw new Error(`git merge-base ${base} HEAD returned empty result; the refs may not share a common ancestor.`);
    }
    const result = runGit(['diff', '--no-color', `${mergeBase}..HEAD`, ...pathArgs], { cwd });
    checkGitResult(result, 'base');
    return result.stdout;
  }
  if (!hasHead(cwd)) {
    const staged = runGit(['diff', '--cached', '--no-color', ...pathArgs], { cwd });
    checkGitResult(staged, 'staged');
    const unstaged = runGit(['diff', '--no-color', ...pathArgs], { cwd });
    checkGitResult(unstaged, 'unstaged');
    return [staged.stdout, unstaged.stdout].filter(Boolean).join('\n');
  }
  const unstaged = runGit(['diff', '--no-color', ...pathArgs], { cwd });
  checkGitResult(unstaged, 'unstaged');
  const staged = runGit(['diff', '--cached', '--no-color', ...pathArgs], { cwd });
  checkGitResult(staged, 'staged');
  return [staged.stdout, unstaged.stdout].filter(Boolean).join('\n');
}

function buildReviewDiff(base, cwd, target = null) {
  const trackedDiff = getTrackedDiff(base, cwd, target);
  if (base) {
    return { diff: trackedDiff, hasRealDiff: trackedDiff.trim().length > 0, skipped: [] };
  }
  const untracked = formatUntrackedDiff(cwd, target);
  return {
    diff: [trackedDiff, untracked.diff].filter(Boolean).join('\n'),
    hasRealDiff: trackedDiff.trim().length > 0 || untracked.hasRealDiff,
    skipped: untracked.skipped,
  };
}

function sanitizePromptInput(s) {
  if (s == null) return '';
  if (typeof s !== 'string') {
    console.warn(`⚠️ sanitizePromptInput received non-string value of type ${typeof s}; converting to string.`);
    s = String(s);
  }
  return s.replace(/[\r\n]+/g, ' ').replace(/```/g, "'''").trim();
}

function makeFence(s) {
  let max = 0;
  for (const m of s.matchAll(/`+/g)) {
    if (m[0].length > max) max = m[0].length;
  }
  return '`'.repeat(Math.max(3, max + 1));
}

function validateBaseRef(base) {
  if (base === undefined || base === null) return;
  const str = String(base);
  if (str.trim() === '') {
    throw new Error('--base requires a non-empty ref');
  }
  if (str.startsWith('-')) {
    throw new Error('--base value cannot start with "-"');
  }
}

function validatePathValue(rawPath) {
  if (rawPath === undefined || rawPath === null) return;
  const str = String(rawPath);
  if (str.trim() === '') {
    throw new Error('--path requires a non-empty value');
  }
  if (str.startsWith('-')) {
    throw new Error('--path value cannot start with "-"');
  }
}

function isTrackedPath(cwd, relPath) {
  const posixRel = relPath.replace(/\\/g, '/');
  if (runGit(['cat-file', '-e', `HEAD:${posixRel}`], { cwd }).status === 0) return true;
  const lsResult = runGit(['ls-files', '--error-unmatch', posixRel], { cwd });
  return lsResult.status === 0;
}

function trackedObjectType(cwd, relPath) {
  const posixRel = relPath.replace(/\\/g, '/');
  const result = runGit(['cat-file', '-t', `HEAD:${posixRel}`], { cwd });
  if (result.status === 0) return result.stdout.trim();
  const idxResult = runGit(['ls-files', '--stage', posixRel], { cwd });
  if (idxResult.status === 0) {
    const mode = idxResult.stdout.trim().split(/\s+/)[0];
    if (mode === '160000') return 'submodule';
    if (mode === '120000') return 'symlink';
    if (mode === '040000') return 'tree';
    return 'blob';
  }
  return 'blob';
}

function resolveTargetPath(rawPath) {
  if (!rawPath) return null;

  const cwdRoot = findGitRoot();
  const absPath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(rawPath);

  let stat;
  let targetType = 'file';
  let deleted = false;
  try {
    stat = fs.lstatSync(absPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`--path must not point to a symlink: ${absPath}`);
    }
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new Error(`--path must point to a file or directory: ${absPath}`);
    }
    targetType = stat.isDirectory() ? 'dir' : 'file';
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const searchRoot = path.dirname(absPath);
      const gitRoot = findGitRoot(searchRoot);
      if (gitRoot) {
        const relPath = path.relative(gitRoot, absPath);
        if (
          relPath !== '..'
          && !relPath.startsWith('..' + path.sep)
          && !path.isAbsolute(relPath)
          && isTrackedPath(gitRoot, relPath)
        ) {
          deleted = true;
          targetType = trackedObjectType(gitRoot, relPath) === 'tree' ? 'dir' : 'file';
        } else {
          throw new Error(`--path does not exist: ${absPath}`);
        }
      } else {
        throw new Error(`--path does not exist: ${absPath}`);
      }
    } else {
      throw err;
    }
  }

  const searchRoot = stat && stat.isDirectory() ? absPath : path.dirname(absPath);
  const gitRoot = findGitRoot(searchRoot);
  if (!gitRoot) {
    throw new Error(`The path ${absPath} is not inside a git repository.`);
  }
  if (cwdRoot && gitRoot !== cwdRoot) {
    throw new Error(`The path ${absPath} is not inside the current git repository (${cwdRoot}).`);
  }
  const relPath = path.relative(gitRoot, absPath);
  if (relPath === '..' || relPath.startsWith('..' + path.sep) || path.isAbsolute(relPath)) {
    throw new Error(`The path ${absPath} is outside the git repository (${gitRoot}).`);
  }
  return {
    absPath,
    gitRoot,
    relPath: relPath || '.',
    targetType,
    deleted,
  };
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
      while (i < s.length && s[i] !== quote) {
        if (s[i] === '\\' && i + 1 < s.length) token += s[++i];
        else token += s[i];
        i++;
      }
      if (i < s.length) i++;
    } else {
      while (i < s.length && !/\s/.test(s[i])) token += s[i++];
    }
    tokens.push(token);
  }
  return tokens;
}

function normalizeArgv(argv) {
  const envArgs = process.env.REVIEW_ARGS;
  if (envArgs !== undefined) {
    const tokens = envArgs.length > 0 ? splitArgsString(envArgs) : [];
    const command = argv[2];
    if (command && tokens[0] !== command) {
      return [command, ...tokens];
    }
    return tokens;
  }
  const args = argv.slice(2).filter((a) => a.length > 0);
  if (args.length === 1 && /\s/.test(args[0])) {
    return splitArgsString(args[0]);
  }
  return args;
}

function parseArgs(argv) {
  const args = normalizeArgv(argv);
  const command = args[0];
  const options = { base: null, focus: '', path: null, probeRuntime: false, prompt: null, promptFile: null, output: null, tools: null, permissionMode: null, model: null, cwd: null, timeoutMs: null, systemPrompt: null, unknown: [], positional: [] };
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
    } else if (args[i] === '--path') {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
        throw new Error('--path requires a value');
      }
      options.path = args[++i];
    } else if (args[i] === '--probe-runtime') {
      options.probeRuntime = true;
    } else if (args[i] === '--prompt') {
      if (i + 1 >= args.length) throw new Error('--prompt requires a value');
      options.prompt = args[++i];
    } else if (args[i] === '--prompt-file') {
      if (i + 1 >= args.length) throw new Error('--prompt-file requires a value');
      options.promptFile = args[++i];
    } else if (args[i] === '--output') {
      if (i + 1 >= args.length) throw new Error('--output requires a value');
      options.output = args[++i];
    } else if (args[i] === '--tools') {
      if (i + 1 >= args.length) throw new Error('--tools requires a value');
      options.tools = args[++i];
    } else if (args[i] === '--permission-mode') {
      if (i + 1 >= args.length) throw new Error('--permission-mode requires a value');
      options.permissionMode = args[++i];
    } else if (args[i] === '--model') {
      if (i + 1 >= args.length) throw new Error('--model requires a value');
      options.model = args[++i];
    } else if (args[i] === '--cwd') {
      if (i + 1 >= args.length) throw new Error('--cwd requires a value');
      options.cwd = args[++i];
    } else if (args[i] === '--timeout-ms') {
      if (i + 1 >= args.length) throw new Error('--timeout-ms requires a value');
      options.timeoutMs = args[++i];
    } else if (args[i] === '--system-prompt') {
      if (i + 1 >= args.length) throw new Error('--system-prompt requires a value');
      options.systemPrompt = args[++i];
    } else if (args[i].startsWith('--prompt-file=')) {
      options.promptFile = args[i].slice(14);
    } else if (args[i].startsWith('--prompt=')) {
      options.prompt = args[i].slice(9);
    } else if (args[i].startsWith('--output=')) {
      options.output = args[i].slice(9);
    } else if (args[i].startsWith('--tools=')) {
      options.tools = args[i].slice(8);
    } else if (args[i].startsWith('--permission-mode=')) {
      options.permissionMode = args[i].slice(18);
    } else if (args[i].startsWith('--model=')) {
      options.model = args[i].slice(8);
    } else if (args[i].startsWith('--cwd=')) {
      options.cwd = args[i].slice(6);
    } else if (args[i].startsWith('--timeout-ms=')) {
      options.timeoutMs = args[i].slice(13);
    } else if (args[i].startsWith('--system-prompt=')) {
      options.systemPrompt = args[i].slice(16);
    } else if (args[i].startsWith('--base=')) {
      const value = args[i].slice(7);
      if (!value) throw new Error('--base requires a value');
      options.base = value;
    } else if (args[i].startsWith('--focus=')) {
      const value = args[i].slice(8);
      if (!value) throw new Error('--focus requires a value');
      options.focus = value;
    } else if (args[i].startsWith('--path=')) {
      const value = args[i].slice(7);
      if (!value) throw new Error('--path requires a value');
      options.path = value;
    } else if (args[i].startsWith('-')) {
      options.unknown.push(args[i]);
    } else {
      options.positional.push(args[i]);
    }
  }
  return { command, options };
}

function claudeOnPath() {
  const result = run(CLAUDE_BIN, ['--version'], { timeout: PROBE_TIMEOUT_MS });
  return result.status === 0;
}

function claudeVersion() {
  const result = run(CLAUDE_BIN, ['--version'], { timeout: PROBE_TIMEOUT_MS });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function claudeAuthOk() {
  const result = run(CLAUDE_BIN, ['auth', 'status'], { timeout: PROBE_TIMEOUT_MS });
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

// -------------------- doctor helpers --------------------

function pluginRoot() {
  // The script lives in <plugin-root>/scripts/*.mjs
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function isWritableDir(dir) {
  try {
    fs.accessSync(dir, fs.constants.F_OK);
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function canConnectSync(host, port) {
  const code = `
    const net = require('net');
    const socket = net.connect(${Number(port)}, ${JSON.stringify(host)}, () => { socket.end(); process.exit(0); });
    socket.setTimeout(${CONNECT_TIMEOUT_MS});
    socket.on('timeout', () => { socket.destroy(); process.exit(1); });
    socket.on('error', () => process.exit(1));
  `;
  const result = run('node', ['-e', code], { timeout: CONNECT_TIMEOUT_MS + 2000 });
  return result.status === 0;
}

function checkProxy() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy) {
    return { ok: true, detail: 'No HTTP(S)_PROXY environment variable set' };
  }
  let host;
  let port;
  try {
    const urlString = /^https?:\/\//i.test(proxy) ? proxy : `http://${proxy}`;
    const u = new URL(urlString);
    host = u.hostname;
    port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      return { ok: false, detail: `Proxy URL has invalid port: ${u.port || '(default)'}` };
    }
  } catch (err) {
    return { ok: false, detail: `Proxy URL parse failed: ${err.message}` };
  }
  const reachable = canConnectSync(host, Number(port));
  if (reachable) {
    return { ok: true, detail: `Proxy socket reachable: ${host}:${port}` };
  }
  return { ok: false, detail: `Proxy socket unreachable: ${host}:${port}` };
}

async function probeClaude() {
  const result = await runAsync(CLAUDE_BIN, [
    '-p', 'Reply exactly: RUNTIME-OK',
    '--output-format', 'text',
    '--bare',
    '--permission-mode', 'plan',
  ], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 });
  if (result.code !== 0) {
    return { ok: false, detail: (result.stderr || '').trim() || `exit ${result.code}` };
  }
  const first = result.stdout.trim().split('\n')[0];
  if (first !== 'RUNTIME-OK') {
    return { ok: false, detail: `unexpected output: "${first}"` };
  }
  return { ok: true, detail: `returned "${first}"` };
}

async function doctor({ probeRuntime, base, focus, path: pathOption, unknown = [], positional = [] }) {
  if (unknown.length) {
    console.error(`❌ Unknown option(s): ${unknown.join(', ')}`);
    process.exit(1);
  }
  if (positional.length) {
    console.error(`❌ Unexpected positional argument(s): ${positional.join(' ')}`);
    process.exit(1);
  }
  if (base !== undefined && base !== null) {
    console.error('❌ --base is not valid for the doctor command.');
    process.exit(1);
  }
  if (focus) {
    console.error('❌ --focus is not valid for the doctor command.');
    process.exit(1);
  }
  if (pathOption) {
    console.error('❌ --path is not valid for the doctor command.');
    process.exit(1);
  }
  const issues = [];
  function report(ok, label, detail = '') {
    const status = ok ? '[OK]' : '[FAIL]';
    const line = detail ? `${label} - ${detail}` : label;
    console.log(`${status} ${line}`);
    if (!ok) issues.push(line);
  }

  console.log('# Claude Code for Kimi - Doctor\n');

  console.log('## Plugin-local checks');
  console.log(`Node.js: ${process.version}`);
  console.log(`Platform: ${process.platform}`);
  const cwdGitRoot = findGitRoot();
  if (cwdGitRoot) {
    report(true, 'Current directory is inside a git repository', cwdGitRoot);
  } else {
    report(false, 'Current directory is not inside a git repository');
  }
  report(isWritableDir(os.tmpdir()), 'Temp directory is writable', os.tmpdir());
  const root = pluginRoot();
  const rootWritable = isWritableDir(root);
  console.log(`${rootWritable ? '[OK]' : '[INFO]'} Plugin root is writable - ${root}${rootWritable ? '' : ' (read-only is OK for managed installs)'}`);
  const kimiHome = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
  report(isWritableDir(kimiHome), 'Kimi Code home is writable', kimiHome);

  console.log('\n## External CLI checks');
  if (claudeOnPath()) {
    report(true, 'Claude CLI found', claudeVersion());
  } else {
    report(false, 'Claude CLI not found on PATH', 'Install from https://claude.ai/code');
  }
  const claudeAuth = claudeAuthOk();
  report(claudeAuth, 'Claude CLI authenticated', claudeAuth ? '' : 'Run `claude auth login`');

  console.log('\n## Network / proxy checks');
  const proxy = checkProxy();
  report(proxy.ok, proxy.detail);
  const proxyConfigured = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
  const direct = canConnectSync('api.anthropic.com', 443);
  if (proxyConfigured) {
    console.log(`[INFO] Direct connection to api.anthropic.com:443 - ${direct ? 'reachable' : 'unreachable'} (proxy is configured)`);
  } else {
    report(direct, 'Direct connection to api.anthropic.com:443');
  }

  if (probeRuntime) {
    console.log('\n## Runtime probe');
    const probe = await probeClaude();
    report(probe.ok, 'Minimal Claude prompt', probe.detail);
  }

  console.log('\n## Summary');
  if (issues.length === 0) {
    console.log('All checks passed.');
  } else {
    console.log(`${issues.length} check(s) failed. See [FAIL] lines above.`);
    process.exit(1);
  }
}

// -------------------- review --------------------

async function review({ base, focus, path: rawPath, probeRuntime, adversarial = false, unknown = [], positional = [] }) {
  if (unknown.length) {
    console.error(`❌ Unknown option(s): ${unknown.join(', ')}`);
    process.exit(1);
  }
  if (probeRuntime) {
    console.error('❌ --probe-runtime is only valid for the doctor command.');
    process.exit(1);
  }

  if (adversarial && positional.length) {
    if (focus) {
      console.error('❌ Cannot use positional focus text together with --focus.');
      process.exit(1);
    }
    focus = positional.join(' ');
  } else if (positional.length) {
    console.error(`❌ Unexpected positional argument(s): ${positional.join(' ')}`);
    process.exit(1);
  }

  let target;
  try {
    validatePathValue(rawPath);
    target = resolveTargetPath(rawPath);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  const gitRoot = target ? target.gitRoot : findGitRoot();
  if (!gitRoot) {
    console.error('❌ Not inside a git repository.');
    process.exit(1);
  }

  if (!claudeOnPath()) {
    console.error('❌ Claude CLI not found on PATH. Run `/kimi-plugin-cc:setup` or `/kimi-plugin-cc:doctor` first.');
    process.exit(1);
  }
  if (!claudeAuthOk()) {
    console.error('❌ Claude CLI is not authenticated. Run `claude auth login` and try again.');
    process.exit(1);
  }

  try {
    validateBaseRef(base);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  if (base) {
    const dirty = runGit(['status', '--porcelain'], { cwd: gitRoot }).stdout.trim();
    if (dirty) {
      console.warn('⚠️ Working tree has uncommitted/untracked changes that are excluded from --base review. Run without --base to include them.');
    }
  }

  let diffResult;
  try {
    diffResult = buildReviewDiff(base, gitRoot, target);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  if (diffResult.skipped.length) {
    console.warn(`⚠️ Skipped untracked files: ${diffResult.skipped.join(', ')}`);
  }
  if (!diffResult.hasRealDiff) {
    console.log('No changes to review.');
    return;
  }
  let diff = diffResult.diff;

  const displayBase = sanitizePromptInput(base);
  const displayFocus = sanitizePromptInput(focus);

  const maxDiffChars = 120000;
  let truncated = false;
  const codePoints = [...diff];
  if (codePoints.length > maxDiffChars) {
    diff = codePoints.slice(0, maxDiffChars).join('') + '\n\n[diff truncated]';
    truncated = true;
  }

  const fence = diff.includes('```') ? makeFence(diff) : '```';

  const systemPrompt = adversarial
    ? `You are a senior staff engineer doing a read-only adversarial code review.${displayFocus ? ` Focus: ${displayFocus}` : ''} Challenge design decisions, trade-offs, hidden assumptions, and failure modes. Be constructive but skeptical. Categorize findings as Critical, Important, or Minor. For each finding include severity, file:line, evidence, why it matters, and a recommended fix. End with an overall verdict.`
    : `You are a senior staff engineer doing a read-only code review. Categorize findings as Critical, Important, or Minor. For each finding include severity, file:line, evidence, why it matters, and a recommended fix. End with an overall verdict.`;

  const promptHeader = [
    'Review the git diff provided on stdin.',
    base ? `Base ref: ${displayBase}` : 'Reviewing current uncommitted changes.',
    displayFocus ? `Focus: ${displayFocus}` : '',
  ].filter(Boolean).join('\n');

  const stdinPayload = [
    `${fence}diff`,
    diff,
    fence,
  ].join('\n');

  const claudeArgs = [
    '-p', promptHeader,
    '--output-format', 'text',
    '--bare',
    '--permission-mode', 'plan',
    '--system-prompt', systemPrompt,
  ];

  const result = await runAsync(CLAUDE_BIN, claudeArgs, {
    cwd: gitRoot,
    maxBuffer: LARGE_BUFFER,
    timeout: REVIEW_TIMEOUT_MS,
    stdin: stdinPayload,
  });

  console.error('## Plugin-local status');
  console.error(`Target: ${target ? target.absPath : gitRoot}`);
  console.error(`Base ref: ${base || '(none)'}`);
  console.error(`Diff size: ${Buffer.byteLength(diff, 'utf8')} bytes sent to Claude`);
  console.error();

  if (result.signal) {
    console.error(`❌ Claude review failed (external CLI) - terminated by signal ${result.signal}.`);
    if (result.stderr) {
      console.error('## External CLI stderr');
      console.error(result.stderr);
    }
    process.exit(1);
  }
  if (result.code !== 0) {
    console.error(`❌ Claude review failed (external CLI) - exit code ${result.code}.`);
    if (result.stderr) {
      console.error('## External CLI stderr');
      console.error(result.stderr);
    }
    process.exit(1);
  }

  console.log('## Claude Code review output\n');
  if (result.stderr) console.error('## External CLI stderr', result.stderr);
  if (truncated) {
    console.log('⚠️ Diff was truncated before sending to Claude.\n');
  }
  console.log(result.stdout);
}


// -------------------- custom-review --------------------

const CUSTOM_REVIEW_DEFAULT_TOOLS = 'Read,Grep,Glob,Bash';
const CUSTOM_REVIEW_DISALLOWED_TOOLS = 'Edit,Write,NotebookEdit';

async function customReview({ prompt, promptFile, output, tools, permissionMode, model, cwd, timeoutMs, systemPrompt, unknown = [], positional = [] }) {
  if (unknown.length) {
    console.error(`❌ Unknown option(s): ${unknown.join(', ')}`);
    process.exit(1);
  }
  if (prompt && promptFile) {
    console.error('❌ Use either --prompt or --prompt-file, not both.');
    process.exit(1);
  }
  let promptText = prompt;
  if (promptFile) {
    const absPromptFile = path.resolve(promptFile);
    try {
      promptText = fs.readFileSync(absPromptFile, 'utf8');
    } catch (err) {
      console.error(`❌ Cannot read --prompt-file: ${absPromptFile} (${err.message})`);
      process.exit(1);
    }
  }
  if (!promptText && positional.length) {
    promptText = positional.join(' ');
  }
  if (!promptText || !promptText.trim()) {
    console.error('❌ custom-review requires --prompt-file, --prompt, or positional prompt text.');
    process.exit(1);
  }

  // Resolve the working directory and output path up front.  (Lesson from
  // field use: relative output redirects fail when the caller's shell runs
  // in a different cwd, e.g. background task wrappers - always absolutize.)
  const workDir = cwd ? path.resolve(cwd) : process.cwd();
  if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
    console.error(`❌ --cwd is not a directory: ${workDir}`);
    process.exit(1);
  }
  let absOutput = null;
  if (output) {
    absOutput = path.isAbsolute(output) ? output : path.resolve(workDir, output);
    try {
      fs.mkdirSync(path.dirname(absOutput), { recursive: true });
    } catch (err) {
      console.error(`❌ Cannot create output directory for: ${absOutput} (${err.message})`);
      process.exit(1);
    }
  }

  if (!claudeOnPath()) {
    console.error('❌ Claude CLI not found on PATH. Run `/kimi-plugin-cc:setup` or `/kimi-plugin-cc:doctor` first.');
    process.exit(1);
  }
  if (!claudeAuthOk()) {
    console.error('❌ Claude CLI is not authenticated. Run `claude auth login` and try again.');
    process.exit(1);
  }

  const mode = permissionMode || 'default';
  if (!['default', 'plan', 'acceptEdits', 'bypassPermissions'].includes(mode)) {
    console.error(`❌ Invalid --permission-mode "${mode}". Allowed: default, plan, acceptEdits, bypassPermissions.`);
    process.exit(1);
  }

  // Prompt goes via stdin: avoids argv length limits and quoting pitfalls.
  // Model is intentionally NOT passed unless the user asks for it - local
  // custom model configurations break when an unknown --model is forced.
  const toolList = tools || CUSTOM_REVIEW_DEFAULT_TOOLS;
  const claudeArgs = [
    '-p',
    '--output-format', 'text',
    '--permission-mode', mode,
    '--no-session-persistence',
    '--allowedTools', toolList,
    '--disallowedTools', CUSTOM_REVIEW_DISALLOWED_TOOLS,
  ];
  if (model) claudeArgs.push('--model', model);
  if (systemPrompt) claudeArgs.push('--system-prompt', systemPrompt);

  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : REVIEW_TIMEOUT_MS;
  const result = await runAsync(CLAUDE_BIN, claudeArgs, {
    cwd: workDir,
    maxBuffer: LARGE_BUFFER,
    timeout,
    stdin: promptText,
  });

  console.error('## Plugin-local status');
  console.error(`Working dir: ${workDir}`);
  console.error(`Permission mode: ${mode}`);
  console.error(`Allowed tools: ${toolList}`);
  if (absOutput) console.error(`Output file: ${absOutput}`);

  if (result.signal) {
    console.error(`❌ Claude custom review failed (external CLI) - terminated by signal ${result.signal}.`);
    if (result.stderr) console.error('## External CLI stderr\n' + result.stderr);
    process.exit(1);
  }
  if (result.code !== 0) {
    console.error(`❌ Claude custom review failed (external CLI) - exit code ${result.code}.`);
    if (result.stderr) console.error('## External CLI stderr\n' + result.stderr);
    process.exit(1);
  }

  if (absOutput) {
    try {
      fs.writeFileSync(absOutput, result.stdout, 'utf8');
      console.error(`✅ Review written to ${absOutput} (${Buffer.byteLength(result.stdout, 'utf8')} bytes)`);
    } catch (err) {
      console.error(`❌ Cannot write output file: ${absOutput} (${err.message})`);
      process.exit(1);
    }
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

async function main() {
  switch (command) {
    case 'setup':
      setup();
      break;
    case 'doctor':
      await doctor(options);
      break;
    case 'review':
      await review(options);
      break;
    case 'adversarial-review':
      await review({ ...options, adversarial: true });
      break;
    case 'custom-review':
      await customReview(options);
      break;
    default:
      console.error(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('❌ Unexpected error:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
