// The chat to reopen after a restart to update, and how its window was (electron/app/restartView.cjs): saved, read once, and only while fresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { saveRestartView, clearRestartView, takeRestartView, MAX_AGE_MS } = require('../electron/app/restartView.cjs');
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'restart-view-'));
const FILE = 'restart-view.json';

test('a saved chat opens the next launch once, as its window hash', () => {
  const d = dir();
  saveRestartView(d, 'acp:kimi:a/b', 1000);
  assert.deepEqual(takeRestartView(d, 2000), { hash: 'thread=acp%3Akimi%3Aa%2Fb', window: undefined });
  assert.equal(fs.existsSync(path.join(d, FILE)), false, 'read once');
  assert.deepEqual(takeRestartView(d, 3000), {});
});

test('a stealth restart also keeps how the window was, with or without a chat in view', () => {
  const d = dir();
  saveRestartView(d, undefined, 0, { visible: false, minimized: true });
  assert.deepEqual(takeRestartView(d, 1), { hash: undefined, window: { visible: false, minimized: true } });
  saveRestartView(d, 'c1', 0, { visible: true, minimized: false });
  assert.deepEqual(takeRestartView(d, 1), { hash: 'thread=c1', window: { visible: true, minimized: false } });
  // a malformed state reads as hidden, not as a window to show
  fs.writeFileSync(path.join(d, FILE), JSON.stringify({ ts: 0, window: { visible: 'yes' } }));
  assert.deepEqual(takeRestartView(d, 1), { hash: undefined, window: { visible: false, minimized: false } });
  fs.writeFileSync(path.join(d, FILE), JSON.stringify({ ts: 0, window: 3 }));
  assert.deepEqual(takeRestartView(d, 1), { hash: undefined, window: undefined });
});

test('no chat in view saves nothing; a cleared, stale, future or malformed marker opens as usual and is removed', () => {
  const d = dir();
  saveRestartView(d, undefined);
  assert.equal(fs.existsSync(path.join(d, FILE)), false);
  saveRestartView(d, 'c1', 0);
  clearRestartView(d);
  assert.deepEqual(takeRestartView(d, 1), {}, 'a refused or failed restart cleared it');
  for (const [body, now] of [
    [JSON.stringify({ chatId: 'c1', ts: 0 }), MAX_AGE_MS],
    [JSON.stringify({ chatId: 'c1', ts: 10 }), 5],
    [JSON.stringify({ chatId: 'c1' }), 1],
  ] as const) {
    fs.writeFileSync(path.join(d, FILE), body);
    assert.deepEqual(takeRestartView(d, now), {}, body);
    assert.equal(fs.existsSync(path.join(d, FILE)), false, body);
  }
  for (const body of [JSON.stringify({ chatId: '', ts: 0 }), JSON.stringify({ chatId: 7, ts: 0 })]) {
    fs.writeFileSync(path.join(d, FILE), body);
    assert.equal(takeRestartView(d, 1).hash, undefined, body);
  }
  fs.writeFileSync(path.join(d, FILE), '{not json');
  assert.deepEqual(takeRestartView(d, 1), {});
});

test('a folder it cannot write or clean up costs only the reopen', () => {
  const d = dir();
  fs.writeFileSync(path.join(d, FILE), JSON.stringify({ chatId: 'c1', ts: 0 }));
  fs.chmodSync(d, 0o500);
  try {
    saveRestartView(d, 'c2', 0);
    assert.equal(takeRestartView(d, 1).hash, 'thread=c1', 'still opens on it when the marker cannot be removed');
    clearRestartView(d);
  } finally {
    fs.chmodSync(d, 0o700);
  }
});
