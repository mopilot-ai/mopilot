import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildDiagnostics } = require('../electron/support/diagnostics.cjs');

test('diagnostics redact secrets and user paths in the environment, and keep the harmless variables', () => {
  const text = buildDiagnostics({
    version: '1.2.3',
    platform: 'darwin',
    arch: 'arm64',
    versions: { electron: '44.0.0', chrome: '140', node: '24' },
    harnesses: { Codex: '/Users/jane/bin/codex', 'Claude Code': null },
    envStatus: { captured: false, error: 'login shell timed out' },
    env: {
      ANTHROPIC_API_KEY: 'sk-ant-api03-supersecretvalue1234567890',
      GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      ANTHROPIC_BASE_URL: 'https://gw.example.com',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
      HOME: '/Users/jane',
    },
    home: '/Users/jane',
  });
  assert.match(text, /MoPilot 1\.2\.3/);
  assert.match(text, /Claude Code: not found/);
  assert.match(text, /not captured \(login shell timed out\)/);
  assert.match(text, /CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000/);
  assert.match(text, /ANTHROPIC_API_KEY=\[REDACTED:secret\]/);
  assert.match(text, /GITHUB_TOKEN=\[REDACTED:secret\]/);
  assert.match(text, /ANTHROPIC_BASE_URL=\[REDACTED:secret\]/);
  for (const leak of ['supersecretvalue', 'ghp_abcdef', 'gw.example.com', 'jane']) assert.ok(!text.includes(leak), leak);
});

test('diagnostics list the recently ignored errors, and leave the section out when there are none', () => {
  const base = { version: '1', platform: 'linux' };
  assert.ok(!buildDiagnostics(base).includes('Recently ignored errors'));
  assert.ok(!buildDiagnostics({ ...base, ignored: [] }).includes('Recently ignored errors'));
  const text = buildDiagnostics({
    ...base,
    home: '/home/jane',
    ignored: [
      { at: '2026-01-01T00:00:00.000Z', context: 'close the tab', message: 'gone at /home/jane/x' },
      { at: '2026-01-01T00:00:01.000Z', context: 'mask a frame', message: 'detached', count: 3 },
    ],
  });
  assert.match(text, /Recently ignored errors \(last 2\)\n {2}2026-01-01T00:00:00\.000Z close the tab: gone at ~\/x\n/);
  assert.match(text, /2026-01-01T00:00:01\.000Z mask a frame: detached \(3 times\)/);
});

test('diagnostics list the app window problems, with exit code and memory when known, and leave the section out when there are none', () => {
  const base = { version: '1', platform: 'darwin' };
  assert.ok(!buildDiagnostics(base).includes('App window problems'));
  assert.ok(!buildDiagnostics({ ...base, windowProblems: [] }).includes('App window problems'));
  const text = buildDiagnostics({
    ...base,
    windowProblems: [
      { at: Date.UTC(2026, 10, 13, 8), window: 'app window', problem: 'renderer gone: oom', exitCode: 5, memoryMB: 812 },
      { at: Date.UTC(2026, 10, 13, 9), window: 'Quick Chat', problem: 'not responding' },
    ],
  });
  assert.match(text, /App window problems \(last 2\)\n {2}2026-11-13T08:00:00\.000Z app window: renderer gone: oom \(5\), 812 MB\n/);
  assert.match(text, / {2}2026-11-13T09:00:00\.000Z Quick Chat: not responding(\n|$)/);
});
