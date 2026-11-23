// An agent's download (electron/capabilities/browser/agentDownloads.cjs), for every harness: the chat's next result says
// where the file landed, or that it was stopped or failed and no file was saved; Codex's Browser plugin hears the same
// end as complete, canceled or failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { drive, setup, tabOf } from './support/browser-host-kit.ts';

const require = createRequire(import.meta.url);
const { downloadOutcome } = require('../electron/capabilities/browser/agentDownloads.cjs');

test('the outcome the agent reads: where the file landed, or that no file was saved and why', () => {
  assert.equal(downloadOutcome('completed', 'a.pdf', '/c/a.pdf'), 'download_completed a.pdf -> /c/a.pdf');
  assert.equal(
    downloadOutcome('cancelled', 'a.pdf', '/c/a.pdf'),
    'download_cancelled a.pdf: stopped before it finished, so no file was saved',
  );
  assert.equal(downloadOutcome('interrupted', 'a.pdf', '/c/a.pdf'), 'download_failed a.pdf: the download failed, so no file was saved');
});

test("a stopped or failed agent download is reported as such on the chat's next result and to the plugin", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const item = (name: string) => Object.assign(new EventEmitter(), { getFilename: () => name, getURL: () => `https://s.test/${name}` });
  const h = setup(t, { downloadsDir: (chatId: string) => path.join(dir, chatId) });
  const tab = tabOf(h);
  tab.hold();
  const events: any[] = [];
  h.tabs.onDownload((e: any) => events.push([path.basename(e.filename), e.status, e.url]));
  const stopped = item('stopped.csv');
  h.tabs.download(stopped, tab.wc);
  stopped.emit('done', {}, 'cancelled');
  assert.match(h.tabs.state('c'), /download_cancelled stopped\.csv: stopped before it finished, so no file was saved/);
  assert.doesNotMatch(h.tabs.state('c'), /stopped\.csv ->/, 'no path for a file that is not there');
  const failed = item('failed.csv');
  h.tabs.download(failed, tab.wc);
  failed.emit('done', {}, 'interrupted');
  assert.match(h.tabs.state('c'), /download_failed failed\.csv: the download failed, so no file was saved/);
  assert.deepEqual(events, [
    ['stopped.csv', 'started', 'https://s.test/stopped.csv'],
    ['stopped.csv', 'canceled', 'https://s.test/stopped.csv'],
    ['failed.csv', 'started', 'https://s.test/failed.csv'],
    ['failed.csv', 'failed', 'https://s.test/failed.csv'],
  ]);
  assert.deepEqual(
    tab.downloads.map((d: any) => d.state),
    ['cancelled', 'interrupted'],
  );
});

test('where a download landed outlives the turn: a file that finishes after the last call is told with the next result', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dl-turn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = setup(t, { downloadsDir: (chatId: string) => path.join(dir, chatId) });
  const tab = tabOf(h);
  tab.hold();
  const before = Object.assign(new EventEmitter(), { getFilename: () => 'early.csv' });
  const after = Object.assign(new EventEmitter(), { getFilename: () => 'late.csv' });
  h.tabs.download(before, tab.wc);
  h.tabs.download(after, tab.wc);
  before.emit('done', {}, 'interrupted');
  h.tabs.change('c', 'tab_opened tab_zzzzzz');
  await drive(t, h.tabs.turnEnded('c'));
  after.emit('done', {}, 'completed');
  const next = h.tabs.state('c');
  assert.match(next, /download_failed early\.csv: the download failed/);
  assert.match(next, /download_completed late\.csv -> /);
  assert.doesNotMatch(next, /tab_opened tab_zzzzzz|download_started/, "the rest of the ended turn's changes are dropped");
});

test("a chat deleted while its agent's download runs is not brought back by the download's end", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dl-forget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = setup(t, { downloadsDir: (chatId: string) => path.join(dir, chatId) });
  const tab = tabOf(h);
  tab.hold();
  const it = Object.assign(new EventEmitter(), { getFilename: () => 'x.csv' });
  h.tabs.download(it, tab.wc);
  h.tabs.forget('c');
  it.emit('done', {}, 'completed');
  assert.equal(h.tabs.chats.has('c'), false);
});
