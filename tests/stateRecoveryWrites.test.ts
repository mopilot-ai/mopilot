// Durable UI, project and Quick Chat state keeps recovery copies before defaults can be saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { flushPendingWrites } = require('../electron/platform/chats.cjs');
const { patchPrefs, writeRendererState } = require('../electron/platform/chats.cjs');
const P = require('../electron/platform/projects.cjs');
const { QuickChatState } = require('../electron/session/quickChat.cjs');
function tmp(t: any) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-state-recovery-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return { d, ui: path.join(d, 'ui-state.json') };
}

test('state writes cannot erase a file whose unreadable contents could not be backed up', (t) => {
  const { ui } = tmp(t);
  const original = JSON.stringify({ prefs: { model: 'keep' }, sidebar: { open: true } });
  fs.writeFileSync(ui, original);
  for (const write of [() => patchPrefs(ui, { notifyOnComplete: true }), () => writeRendererState(ui, { sidebar: { open: false } })]) {
    fs.chmodSync(ui, 0o200);
    try {
      assert.throws(write, /EACCES/);
    } finally {
      fs.chmodSync(ui, 0o600);
    }
    assert.equal(fs.readFileSync(ui, 'utf8'), original);
    assert.equal(fs.existsSync(`${ui}.unreadable`), false);
  }
});

test('non-object state JSON is backed up before settings replace it with defaults', (t) => {
  for (const text of ['null', '[{"prefs":{"model":"keep"}}]', '7', 'true', '"old state"']) {
    const { ui } = tmp(t);
    fs.writeFileSync(ui, text);
    assert.deepEqual(patchPrefs(ui, { notifyOnComplete: true }), { notifyOnComplete: true });
    assert.equal(fs.readFileSync(`${ui}.unreadable`, 'utf8'), text);
    flushPendingWrites();
    assert.equal(JSON.parse(fs.readFileSync(ui, 'utf8')).prefs.notifyOnComplete, true);
  }
});

test('a project write cannot replace unreadable state without a recovery copy; repair and reopening permit retry', (t) => {
  const file = path.join(tmp(t).d, 'projects.json');
  const original = JSON.stringify({ projects: [{ id: 'keep', name: 'Keep', path: '/keep' }] });
  fs.writeFileSync(file, original);
  const store = new P.ProjectsStore(file);
  fs.chmodSync(file, 0o200);
  try {
    assert.throws(
      () => store.rename('keep', 'Changed'),
      (error: any) => error.cause?.code === 'EACCES',
    );
  } finally {
    fs.chmodSync(file, 0o600);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.existsSync(`${file}.unreadable`), false);
  const reopened = new P.ProjectsStore(file);
  reopened.rename('keep', 'Changed');
  assert.equal(reopened.snapshot().projects[0].name, 'Changed');
});

test('Quick Chat recovery preserves the previous draft before reading defaults or saving a replacement', (t) => {
  for (const action of ['read', 'save']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-recovery-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'quick-chat.json');
    const original = '{"threadId":"chat","text":"unfinished';
    fs.writeFileSync(file, original);
    const state = new QuickChatState(file, () => true);
    if (action === 'read') assert.deepEqual(state.read(), { threadId: null, text: '' });
    else state.save({ threadId: 'chat', text: 'replacement' });
    assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), original);
  }
});
