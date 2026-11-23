// Live fake usage windows remain active through calendar boundaries, using the production parser and reset policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeClaudeUsage } from './e2e/fixtures/fake-claude-usage.mjs';
import { parseUsageText } from '../src/harness/claudeUsage.ts';
import { usedNow } from '../src/harness/usageWindows.ts';

for (const now of [Date.UTC(2026, 9, 15, 8, 45), Date.UTC(2026, 11, 31, 23, 59), Date.UTC(2028, 1, 29, 23, 59)]) {
  test(`fake usage keeps active session and weekly windows at ${new Date(now).toISOString()}`, (t) => {
    t.mock.timers.enable({ apis: ['Date'], now });
    const reading = parseUsageText(fakeClaudeUsage())!;
    assert.deepEqual(
      reading.windows.map((window) => usedNow(window)),
      [12, 34],
    );
    assert.deepEqual(
      reading.windows.map((window) => window.resetsAt),
      [(now + 5 * 3600_000) / 1000, (now + 7 * 86400_000) / 1000],
    );
  });
}

test('the actual fake CLI query uses fresh reset dates rather than a fixed reply', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-usage-'));
  try {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./e2e/fixtures/fake-claude.mjs', import.meta.url)),
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
      ],
      {
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude') },
        input: JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '/usage' }] } }) + '\n',
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    const reply = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((entry) => entry.type === 'result');
    assert.ok(reply, 'the scripted query must produce a result');
    const windows = parseUsageText(reply.result)!.windows;
    assert.deepEqual(
      windows.map((window) => usedNow(window)),
      [12, 34],
    );
    assert.ok(windows.every((window) => window.resetsAt! * 1000 > Date.now()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
