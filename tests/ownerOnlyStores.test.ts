// The stores that write user content in the data folder with plain fs calls make it owner-only (#2144): kept
// screenshots and GIFs, a chat's upload folder, Chrome panel attachments, chat transcripts (items logs), the browser
// history database with its journal files, migration backups, pasted images and the cloud-provider switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe } from './support/computerHistory.ts';

const require = createRequire(import.meta.url);
const { writeShot } = require('../electron/capabilities/browser/hostScreenshots.cjs');
const { writeGif } = require('../electron/capabilities/browser/gifRecorder.cjs');
const { PanelFiles } = require('../electron/app/chromePanelFiles.cjs');
const { ItemsLog } = require('../electron/platform/itemsLog.cjs');
const { TranscriptWriter } = require('../electron/platform/transcriptWriter.cjs');
const { HistoryStore } = require('../electron/capabilities/browser/historyStore.cjs');
const { backup } = require('../electron/migrations/migrate.cjs');

const mode = (p: string) => fs.statSync(p).mode & 0o777;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'owner-only-'));
const PNG = Buffer.from('iVBORw0KGgo=', 'base64').toString('base64');

test('kept screenshots and GIFs are 0600 in 0700 folders', () => {
  const root = tmp();
  const shot = writeShot(root, { mimeType: 'image/png', data: PNG, url: 'https://example.test/' }, 'id1');
  assert.equal(mode(shot), 0o600);
  assert.equal(mode(path.dirname(shot)), 0o700);
  const gif = writeGif(root, Buffer.from('GIF89a'), 'run');
  assert.equal(mode(gif), 0o600);
  assert.equal(mode(path.dirname(gif)), 0o700);
});

test('Chrome panel attachments are 0600 in a 0700 folder', () => {
  const dir = tmp();
  const files = new PanelFiles({ dir });
  const saved = files.save({ dataUrl: `data:text/plain;base64,${Buffer.from('hi').toString('base64')}`, name: 'note.txt' });
  const file = saved.path ?? files.take([saved.id])[0]?.path;
  assert.equal(mode(file), 0o600);
  assert.equal(mode(path.dirname(file)), 0o700);
});

test('a chat transcript (items log) is created 0600', async () => {
  const dir = tmp();
  const log = new ItemsLog(dir, { writer: new TranscriptWriter() });
  log.append('chat-1', { type: 'x' });
  await log.flush('chat-1');
  assert.equal(mode(log.file('chat-1')), 0o600);
});

test('the browser history is saved sealed, 0600 in a 0700 folder', () => {
  const dir = path.join(tmp(), 'data');
  const store = new HistoryStore({ file: path.join(dir, 'browser-history.sqlite'), safeStorage: fakeSafe() });
  assert.equal(store.record({ url: 'https://example.test/a', title: 'A' }), true);
  store.close();
  for (const f of fs.readdirSync(dir).filter((n) => n.startsWith('browser-history'))) assert.equal(mode(path.join(dir, f)), 0o600, f);
  assert.equal(mode(dir), 0o700);
});

test('a migration backup of the chats is owner-only, whatever the originals were', () => {
  const ud = tmp();
  fs.mkdirSync(path.join(ud, 'threads'));
  fs.writeFileSync(path.join(ud, 'threads', 'a.json'), '{}', { mode: 0o644 });
  fs.chmodSync(path.join(ud, 'threads', 'a.json'), 0o644);
  fs.writeFileSync(path.join(ud, 'ui-state.json'), '{}', { mode: 0o644 });
  const dir = backup(ud, 'pre-test', Date.UTC(2026, 9, 23));
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(path.join(dir, 'threads')), 0o700);
  assert.equal(mode(path.join(dir, 'threads', 'a.json')), 0o600);
  assert.equal(mode(path.join(dir, 'ui-state.json')), 0o600);
});
