// Last-used model settings are read through the real transcript module, including synthetic-record filtering, and
// the file handles of those asynchronous reads are closed on every path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { sessionSettings: read, goalStatus } = createRequire(import.meta.url)('../electron/harness/claude/transcripts.cjs');
test('synthetic assistant records cannot replace the actual model and effort', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-settings-'));
  const project = path.join(dir, 'projects', 'project');
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, 'session.jsonl');
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  const records = [
    { type: 'assistant', effort: 'high', message: { model: 'claude-opus-5-5' } },
    { type: 'assistant', message: { model: '<synthetic>' } },
  ];
  try {
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));
    assert.deepEqual(await read('session'), { model: 'claude-opus-5-5', effort: 'high' });
    fs.writeFileSync(file, JSON.stringify(records[1]));
    assert.equal(await read('session'), null);
    fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { model: 42 } }));
    assert.equal(await read('session'), null);
    fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { model: 'valid' }, effort: 42 }));
    assert.deepEqual(await read('session'), { model: 'valid', effort: null });
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A project folder with one transcript, as CLAUDE_CONFIG_DIR for the test. */
function transcriptDir(t: any, record: object) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-settings-'));
  const project = path.join(dir, 'projects', 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'session.jsonl'), JSON.stringify(record));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

/** File handles opened from now on, with their read or close failing as asked; `closed` counts closes. */
function handles(t: any, fail: { read?: boolean; close?: boolean } = {}) {
  const seen = { closed: 0 };
  const open = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, 'open', async (...a: Parameters<typeof fs.promises.open>) => {
    const h = await open(...a);
    return {
      stat: () => h.stat(),
      read: (...r: any[]) => (fail.read ? Promise.reject(new Error('EIO: i/o error')) : (h.read as any)(...r)),
      close: async () => {
        seen.closed++;
        await h.close();
        if (fail.close) throw new Error('EIO: i/o error, close');
      },
    };
  });
  return seen;
}

test('a transcript that fails to read closes its file and records the failure', async (t) => {
  transcriptDir(t, { type: 'assistant', message: { model: 'm' } });
  const { recentIgnored, clearIgnored } = createRequire(import.meta.url)('../electron/ignored.cjs');
  clearIgnored();
  const seen = handles(t, { read: true });
  assert.equal(await read('session'), null);
  assert.equal(seen.closed, 1, 'the file handle is closed after the failed read');
  assert.deepEqual(
    recentIgnored().map((e: any) => [e.context, e.message]),
    [["read a Claude Code session's model", 'EIO: i/o error']],
  );
});

test("a transcript handle that won't close is recorded, and the model read still counts", async (t) => {
  transcriptDir(t, { type: 'assistant', message: { model: 'm' } });
  const { recentIgnored, clearIgnored } = createRequire(import.meta.url)('../electron/ignored.cjs');
  clearIgnored();
  handles(t, { close: true });
  assert.deepEqual(await read('session'), { model: 'm', effort: null });
  assert.deepEqual(
    recentIgnored().map((e: any) => e.context),
    ['close a Claude Code transcript'],
  );
});

test('a goal status read that fails closes its file too', async (t) => {
  transcriptDir(t, { type: 'goal_status', n: 1 });
  const seen = handles(t);
  assert.equal(await goalStatus('session'), '{"type":"goal_status","n":1}');
  assert.equal(seen.closed, 1);
  t.mock.restoreAll();
  const failing = handles(t, { read: true });
  assert.equal(await goalStatus('session'), null);
  assert.equal(failing.closed, 1, 'the file handle is closed after the failed read');
  // a file that can't be opened has no handle to close
  t.mock.method(fs.promises, 'open', async () => {
    throw new Error('EACCES: permission denied');
  });
  assert.equal(await goalStatus('session'), null);
  assert.equal(failing.closed, 1);
});
