// User-level instruction files: which path each harness reads (src/harness/instructions.ts), and
// main's fs:writeText / config roots (electron/platform/fs.cjs, sharedRoot from harness/claude/accounts.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { instructionsPath } = await import('../src/harness/instructions.ts');
const require = createRequire(import.meta.url);
const fsPlatform = require('../electron/platform/fs.cjs');
const { sharedRoot } = require('../electron/harness/claude/accounts.cjs');

const roots = { home: '/Users/me', codexHome: '/custom/codex', claudeRoot: '/Users/me/.claude' };

test('first tier: AGENTS.md in $CODEX_HOME, CLAUDE.md in the Claude CLI folder', () => {
  assert.equal(instructionsPath('codex', roots), '/custom/codex/AGENTS.md');
  assert.equal(instructionsPath('claude', roots), '/Users/me/.claude/CLAUDE.md');
  assert.equal(instructionsPath('claude', { ...roots, claudeRoot: '/elsewhere/claude' }), '/elsewhere/claude/CLAUDE.md');
});

test('basic tier: the user-level file its quirks name, none when it names only repository files', () => {
  assert.equal(instructionsPath('acp:gemini', roots), '/Users/me/.gemini/GEMINI.md');
  assert.equal(instructionsPath('acp:qwen', roots), '/Users/me/.qwen/QWEN.md');
  assert.equal(instructionsPath('acp:opencode', roots), '/Users/me/.config/opencode/AGENTS.md');
  assert.equal(instructionsPath('acp:kimi', roots), null);
  assert.equal(instructionsPath('acp:goose', roots), null);
  assert.equal(instructionsPath('acp:unknown', roots), null);
});

test('config roots respect CODEX_HOME and CLAUDE_CONFIG_DIR', () => {
  assert.equal(fsPlatform.configRoots({ CODEX_HOME: '/x/codex' }, '/Users/me').codexHome, '/x/codex');
  assert.equal(fsPlatform.configRoots({}, '/Users/me').codexHome, '/Users/me/.codex');
  const prev = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = '/x/claude';
    assert.equal(sharedRoot(), '/x/claude');
    assert.equal(fsPlatform.configRoots({}, '/Users/me').claudeRoot, '/x/claude');
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.equal(sharedRoot(), path.join(os.homedir(), '.claude'));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test('writeText makes the folder, replaces the file, and writes through a symlink', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-fs-')));
  try {
    const file = path.join(dir, 'new', 'CLAUDE.md');
    assert.deepEqual(fsPlatform.writeText(file, 'one\n'), { ok: true });
    assert.deepEqual(fsPlatform.writeText(file, 'two\n'), { ok: true });
    assert.equal(fs.readFileSync(file, 'utf8'), 'two\n');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['CLAUDE.md']);

    const real = path.join(dir, 'dotfiles', 'AGENTS.md');
    fs.mkdirSync(path.dirname(real));
    fs.writeFileSync(real, 'old');
    if (process.platform !== 'win32') fs.chmodSync(real, 0o600);
    const link = path.join(dir, 'AGENTS.md');
    fs.symlinkSync(real, link);
    assert.deepEqual(fsPlatform.writeText(link, 'new'), { ok: true });
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.readFileSync(real, 'utf8'), 'new');
    if (process.platform !== 'win32') assert.equal(fs.statSync(real).mode & 0o777, 0o600);

    assert.equal(fsPlatform.writeText('relative.md', 'x').ok, false);
    assert.equal(fsPlatform.writeText(file, 42 as any).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
