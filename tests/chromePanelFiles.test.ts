// Files the Chrome side panel attaches (electron/app/chromePanelFiles.cjs, the router's attach and attachment ids in electron/capabilities/browser/chromePanel.cjs, and main's message in app/chromePanel.cjs): kept by id, only those go with a message, and what is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PanelFiles, safeName, MAX_BYTES } = require('../electron/app/chromePanelFiles.cjs');
const { ChromePanel } = require('../electron/capabilities/browser/chromePanel.cjs');
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');

const PNG = `data:image/png;base64,${Buffer.from('png bytes').toString('base64')}`;
const TEXT = `data:text/plain;charset=utf-8;base64,${Buffer.from('notes').toString('base64')}`;

function scratch(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a screenshot is an image and anything else a file, each in a folder of its own under the name given', (t) => {
  const dir = scratch(t);
  const files = new PanelFiles({ dir });
  const shot = files.save({ dataUrl: PNG, name: 'Screenshot of Hacker News.png' });
  assert.match(shot.id, /^[0-9a-f]{16}$/);
  assert.deepEqual([shot.name, shot.kind], ['Screenshot of Hacker News.png', 'image']);
  const notes = files.save({ dataUrl: TEXT, name: '../../etc/notes:v2.txt' });
  assert.deepEqual([notes.name, notes.kind], ['notes:v2.txt', 'file']);
  const [a, b] = files.take([shot.id, notes.id]);
  assert.deepEqual(a, {
    kind: 'image',
    path: path.join(dir, `panel-${shot.id}`, 'Screenshot_of_Hacker_News.png'),
    name: 'Screenshot of Hacker News.png',
  });
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'png bytes');
  assert.equal(path.dirname(path.dirname(b.path)), dir);
  // on disk with no space or other mark a harness reads as the end of the path
  assert.equal(path.basename(b.path), 'notes_v2.txt');
  // a name of only spaces: the file's own
  assert.equal(files.save({ dataUrl: PNG, name: '   ' }).name, 'file');
  assert.equal(fs.readFileSync(b.path, 'utf8'), 'notes');
  // a data: URL with no type is a file
  assert.equal(files.save({ dataUrl: `data:;base64,${Buffer.from('x').toString('base64')}`, name: 'x' }).kind, 'file');
});

test('names that are nothing safe, a URL that is no file, one too large, an id never attached', (t) => {
  assert.equal(safeName('...'), 'file');
  assert.equal(safeName('.env'), 'env');
  assert.equal(safeName('a'.repeat(300)).length, 120);
  const files = new PanelFiles({ dir: scratch(t) });
  assert.throws(() => files.save({ dataUrl: 'data:text/plain,hello', name: 'a' }), /That file couldn't be read/);
  const big = `data:application/octet-stream;base64,${Buffer.alloc(MAX_BYTES + 1).toString('base64')}`;
  assert.throws(() => files.save({ dataUrl: big, name: 'big' }), /larger than 20 MB/);
  assert.throws(() => files.take(['0123456789abcdef']), /Attach that file again/);
});

test('an attachment not sent within a day is forgotten and its file goes; a sent one’s file stays for its harness', (t) => {
  let now = 0;
  const files = new PanelFiles({ dir: scratch(t), now: () => now });
  const old = files.save({ dataUrl: PNG, name: 'a.png' });
  const sent = files.save({ dataUrl: PNG, name: 's.png' });
  const [oldFile] = files.take([old.id]);
  const [sentFile] = files.take([sent.id]);
  files.sent([sent.id, 'f'.repeat(16)]);
  now = 25 * 60 * 60 * 1000;
  const fresh = files.save({ dataUrl: PNG, name: 'b.png' });
  assert.throws(() => files.take([old.id]), /Attach that file again/);
  assert.throws(() => files.take([sent.id]), /Attach that file again/);
  assert.equal(fs.existsSync(oldFile.path), false);
  assert.equal(fs.existsSync(sentFile.path), true);
  assert.equal(files.take([fresh.id]).length, 1);
  // the default folder is the app's pasted images'
  assert.equal(new PanelFiles().dir, path.join(os.tmpdir(), 'sage-codex-attachments'));
});

test('the requests: a file to attach, and the ids a message carries', async () => {
  const calls: any[] = [];
  const panel = new ChromePanel({
    attach: (f: any) => (calls.push(['attach', f]), { id: 'a'.repeat(16), name: f.name, kind: 'image' }),
    usable: async () => true,
    start: async (p: any) => (calls.push(['start', p]), 'c1'),
    send: async (p: any) => calls.push(['send', p]),
  });
  const ask = async (method: string, params: any) => {
    let out: any;
    await panel.handle({ id: 1, method, params }, (m: any) => (out = m));
    return out.error ?? out.result;
  };
  assert.deepEqual(await ask('attach', { dataUrl: PNG, name: 'x.png' }), { id: 'a'.repeat(16), name: 'x.png', kind: 'image' });
  assert.deepEqual(calls.at(-1), ['attach', { dataUrl: PNG, name: 'x.png' }]);
  await ask('attach', { dataUrl: PNG, name: '' });
  assert.equal(calls.at(-1)[1].name, 'file');
  await ask('attach', { dataUrl: PNG, name: 'n'.repeat(500) });
  assert.equal(calls.at(-1)[1].name.length, 200);
  assert.equal(await ask('attach', { dataUrl: 'file:///etc/passwd', name: 'x' }), "That file couldn't be read.");
  assert.equal(await ask('attach', { name: 'x' }), "That file couldn't be read.");
  assert.equal(await ask('attach', { dataUrl: `data:,${'x'.repeat(28 * 1024 * 1024)}` }), 'That file is larger than 20 MB.');
  const id = 'b'.repeat(16);
  await ask('start', { harness: 'claude', text: 'what is this?', attachments: [id] });
  assert.deepEqual(calls.at(-1)[1].attachments, [id]);
  await ask('send', { chatId: 'c1', text: 'and this?', attachments: [id, id] });
  assert.deepEqual(calls.at(-1)[1].attachments, [id, id]);
  for (const bad of [['/etc/passwd'], 'abc', Array(11).fill(id), [7]])
    assert.equal(await ask('send', { chatId: 'c1', text: 'x', attachments: bad }), 'Attach those files again.');
});

test('main: the files attached go with the message as the queue takes them; one not attached here refuses it before a chat is made', async (t) => {
  const dir = scratch(t);
  const calls: any[] = [];
  const records = new Map<string, any>([['th-1', { segments: [{ kind: 'codex', nativeId: 'th-1' }], meta: {} }]]);
  // a new chat's meta is saved as the chat store does (a Claude chat keeps its model and effort)
  const live: any = { chats: { records, patchMeta: () => true }, controller: { state: new Map(), onLiveEvent: null } };
  const panel = createChromePanel({
    live,
    sources: {},
    projectsFile: projectsFileOf(dir),
    home: dir,
    prefs: () => ({ projectlessFolder: path.join(dir, 'chats') }),
    usable: async () => true,
    starter: {
      prefs: () => ({}),
      codexThread: async () => (calls.push(['codex']), { id: 'th-new' }),
      claudeSession: (key: string) => calls.push(['claude', key]),
      acpSession: () => undefined,
      chats: live.chats,
      started: () => undefined,
    },
    send: async (chatId: string, item: any) => {
      calls.push(['send', chatId, item]);
      return { action: 'started', id: 'panel-input' };
    },
    open: () => undefined,
    files: new PanelFiles({ dir: path.join(dir, 'files') }),
    now: () => new Date('2026-10-22T10:00:00Z'),
  });
  const ask = async (method: string, params: any) => {
    let out: any;
    await panel.handle({ id: 1, method, params }, (m: any) => (out = m));
    return out.error ?? out.result;
  };
  const shot = await ask('attach', { dataUrl: PNG, name: 'Screenshot of Example.png' });
  await ask('start', { harness: 'claude', text: 'What is on this page?', attachments: [shot.id] });
  const [, , item] = calls.at(-1);
  assert.deepEqual(item.attachments, [
    { kind: 'image', path: path.join(dir, 'files', `panel-${shot.id}`, 'Screenshot_of_Example.png'), name: 'Screenshot of Example.png' },
  ]);
  assert.deepEqual(item.opts, { human: true });
  await ask('send', { chatId: 'th-1', text: 'and again', attachments: [shot.id] });
  assert.equal(calls.at(-1)[2].attachments.length, 1);
  const before = calls.length;
  assert.equal(await ask('start', { harness: 'claude', text: 'x', attachments: ['c'.repeat(16)] }), 'Attach that file again.');
  assert.equal(calls.length, before);
});

test('remote file operations resolve only saved ids and retain sent files for durable remote delivery', (t) => {
  const dir = scratch(t);
  let now = 0;
  const files = new PanelFiles({ dir, now: () => now });
  const ops = files.remoteOps();
  const saved = ops.attach({ name: 'picked.png', dataUrl: PNG });
  const [attachment] = ops.attachmentsForHost([saved.id]);
  assert.equal(attachment.kind, 'image');
  assert.equal(fs.readFileSync(attachment.path, 'utf8'), 'png bytes');
  ops.attachmentsSent([saved.id]);
  now = 3 * 24 * 60 * 60 * 1000;
  files.prune();
  assert.equal(fs.existsSync(attachment.path), true);
  assert.throws(() => ops.attachmentsForHost([saved.id]), /Attach/);
});
