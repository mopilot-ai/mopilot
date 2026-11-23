// The pane tools (electron/capabilities/tools/paneTools.cjs): only in a window showing the caller (else nothing changes
// and the model is told why), a file only inside the chat's folder, a terminal only in a folder the user allowed (once
// per folder and chat), and a result only for what the window reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { registerPaneTools, SAID } = require('../electron/capabilities/tools/paneTools.cjs');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pane-tools-')));
fs.mkdirSync(path.join(root, 'src'));
fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'x\n');
// the folder reached through a link, and a link inside it that leads out
const linked = `${root}-link`;
fs.symlinkSync(root, linked);
const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-out-'));
fs.writeFileSync(path.join(elsewhere, 'secret.ts'), 'x\n');
fs.symlinkSync(path.join(elsewhere, 'secret.ts'), path.join(root, 'src', 'out.ts'));

function fakeWindow(id: number, ipcMain: EventEmitter, o: { focused?: boolean; answer?: (req: any) => any; reload?: boolean } = {}) {
  const sent: any[] = [];
  const wc: any = Object.assign(new EventEmitter(), {
    id,
    isCrashed: () => false,
    send: (channel: string, rid: number, req: any) => {
      sent.push([channel, req]);
      if (o.reload) return queueMicrotask(() => wc.emit('did-start-loading'));
      queueMicrotask(() => ipcMain.emit(`${channel}:reply`, {}, rid, o.answer ? o.answer(req) : { outcome: 'shown' }));
    },
  });
  return { win: { webContents: wc, isDestroyed: () => false, isFocused: () => !!o.focused }, sent };
}

function setup(over: Record<string, any> = {}) {
  const ipcMain = new EventEmitter();
  const viewedBy = new Map<number, any>();
  const show = (id: number, visible: string[]) => viewedBy.set(id, { visible, primary: visible[0] ?? null, focused: visible[0] ?? null });
  const wins: any[] = [];
  const asked: any[] = [];
  const r = new Registry();
  r.setApprover(async () => true);
  const dispose = registerPaneTools(r, {
    owner: (ctx: any) => (ctx.segmentId === 'seg' ? ctx.chatId : null),
    viewedBy,
    windows: () => wins,
    projectOf: async (chatId: string) => {
      const folders: Record<string, string | null> = { nofolder: null, slash: `${root}/`, linked, gone: path.join(root, 'gone') };
      return Object.hasOwn(folders, chatId) ? folders[chatId] : root;
    },
    approveTerminal: async (chatId: string, signal: any, req: any) => {
      // the call's own signal, so a stopped call withdraws the card
      assert.ok(signal instanceof AbortSignal);
      asked.push([chatId, req]);
      over.onAsk?.();
      return over.allow ?? true;
    },
    ipcMain,
    replyMs: 1000,
  });
  const call = async (tool: string, args: any, chat = 'c') => {
    const res = await r.invoke(chat, 'seg', tool, args);
    return res.ok ? JSON.parse(res.content[0].text) : { error: res.error };
  };
  return { r, ipcMain, show, wins, asked, call, dispose };
}

test('the tools: names, policies, and a chat on no screen changes nothing', async () => {
  const t = setup();
  assert.deepEqual(
    t.r.list().map((x: any) => [x.name, x.policy]),
    [
      ['show_pane', 'act'],
      ['close_pane', 'act'],
      ['open_terminal_tab', 'act'],
      ['run_in_terminal', 'act'],
      ['read_terminal', 'act'],
      ['stop_terminal_tab', 'act'],
    ],
  );
  for (const [tool, args] of [
    ['show_pane', { pane: 'diff' }],
    ['close_pane', { pane: 'diff' }],
    ['open_terminal_tab', {}],
  ] as const)
    assert.deepEqual(await t.call(tool, args), { changed: false, outcome: 'not_on_screen', said: SAID.not_on_screen() });
  assert.deepEqual(t.asked, [], 'no card for a chat on no screen');
  // a segment the caller doesn't own
  assert.match(String((await t.r.invoke('c', 'other', 'show_pane', { pane: 'diff' })).error?.message), /does not own/);
  t.dispose();
  assert.deepEqual(t.r.list(), []);
});

test('show_pane: what each pane sends the window showing the caller, and what the model hears back', async () => {
  const t = setup();
  const other = fakeWindow(1, t.ipcMain);
  const w = fakeWindow(2, t.ipcMain, { focused: true });
  t.wins.push(other.win, w.win);
  t.show(1, ['c']);
  t.show(2, ['c']);
  assert.deepEqual(await t.call('show_pane', { pane: 'diff', path: ' src/a.ts ', diff_scope: 'turn' }), {
    changed: true,
    outcome: 'shown',
    said: 'Showing the diff pane.',
  });
  assert.deepEqual(w.sent.at(-1), [
    'window:layout',
    { op: 'show_pane', caller: 'c', chatId: null, pane: 'diff', path: 'src/a.ts', scope: 'turn' },
  ]);
  assert.equal(other.sent.length, 0, 'the focused window showing the chat is asked');
  await t.call('show_pane', { pane: 'diff' });
  assert.equal(w.sent.at(-1)[1].scope, 'branch');
  // a file inside the chat's folder, relative or absolute; a line only when it is a positive whole number
  await t.call('show_pane', { pane: 'file', path: 'src/a.ts', line: 3 });
  assert.deepEqual(w.sent.at(-1)[1], {
    op: 'show_pane',
    caller: 'c',
    chatId: null,
    pane: 'file',
    path: path.join(root, 'src', 'a.ts'),
    line: 3,
  });
  await t.call('show_pane', { pane: 'file', path: path.join(root, 'src', 'a.ts'), line: 0.5 });
  assert.equal('line' in w.sent.at(-1)[1], false);
  // terminal and preview pass a tab id; tasks nothing more
  await t.call('show_pane', { pane: 'terminal', tab_id: 'terminal-1' });
  assert.equal(w.sent.at(-1)[1].tabId, 'terminal-1');
  await t.call('show_pane', { pane: 'preview', tab_id: 'tab_aaaaaa' });
  assert.equal(w.sent.at(-1)[1].tabId, 'tab_aaaaaa');
  await t.call('show_pane', { pane: 'tasks', tab_id: 'ignored' });
  assert.equal('tabId' in w.sent.at(-1)[1], false);
  // an artifact: only a claude.ai artifact or design link, refused before anything is shown
  const page = 'https://claude.ai/design/p/proj-1234';
  assert.deepEqual(await t.call('show_pane', { pane: 'artifact', url: page }), {
    changed: true,
    outcome: 'shown',
    said: 'Showing the artifact pane.',
  });
  assert.deepEqual(w.sent.at(-1)[1], { op: 'show_pane', caller: 'c', chatId: null, pane: 'artifact', url: page });
  const sent = w.sent.length;
  for (const url of [undefined, 'https://claude.ai.example.com/design/p/proj-1234', 'https://example.com/'])
    assert.match(String((await t.call('show_pane', { pane: 'artifact', url })).error?.message), /needs url: a claude.ai artifact/);
  assert.equal(w.sent.length, sent);
  // the window's own outcomes, each with what to do next
  for (const outcome of ['no_page', 'no_terminal', 'no_tab', 'not_focused', 'not_on_screen']) {
    const said = setup();
    said.wins.push(fakeWindow(3, said.ipcMain, { answer: () => ({ outcome }) }).win);
    said.show(3, ['c']);
    assert.deepEqual(await said.call('show_pane', { pane: 'preview' }), { changed: false, outcome, said: SAID[outcome]() });
  }
  // an outcome this version has no words for still reports what happened
  const odd = setup();
  odd.wins.push(fakeWindow(4, odd.ipcMain, { answer: () => ({ outcome: 'new' }) }).win);
  odd.show(4, ['c']);
  assert.deepEqual(await odd.call('show_pane', { pane: 'tasks' }), { changed: false, outcome: 'new', said: '' });
});

test('show_pane refuses a bad pane or scope, a missing path, a file outside the folder or not there', async () => {
  const t = setup();
  const w = fakeWindow(1, t.ipcMain);
  t.wins.push(w.win);
  t.show(1, ['c', 'nofolder']);
  const err = async (args: any, chat = 'c') => String((await t.call('show_pane', args, chat)).error?.message ?? '');
  assert.match(await err({ pane: 'gallery' }), /pane must be one of/);
  assert.match(await err({ pane: 'diff', diff_scope: 'abc123' }), /diff_scope must be/);
  assert.match(await err({ pane: 'file' }), /needs a path/);
  assert.match(await err({ pane: 'file', path: '  ' }), /needs a path/);
  assert.match(await err({ pane: 'file', path: '../outside.ts' }), /not inside this session's working directory \(/);
  assert.match(await err({ pane: 'file', path: path.join(root + 'x', 'a.ts') }), /not inside/);
  assert.match(await err({ pane: 'file', path: 'src/missing.ts' }), /No file at/);
  assert.match(await err({ pane: 'file', path: 'src' }), /No file at/);
  assert.match(await err({ pane: 'file', path: '.' }), /No file at/, 'the folder itself is inside, but no file');
  // a folder given with a trailing separator still holds its files
  t.show(1, ['c', 'nofolder', 'slash']);
  assert.deepEqual(await t.call('show_pane', { pane: 'file', path: 'src/a.ts' }, 'slash'), {
    changed: true,
    outcome: 'shown',
    said: 'Showing the file pane.',
  });
  // the folder through its link: a file given by its real path is still inside
  t.show(1, ['c', 'nofolder', 'slash', 'linked', 'gone']);
  assert.equal((await t.call('show_pane', { pane: 'file', path: path.join(root, 'src', 'a.ts') }, 'linked')).outcome, 'shown');
  // a link inside that leads out is outside; a folder that is gone holds nothing
  assert.match(await err({ pane: 'file', path: 'src/out.ts' }), /not inside/);
  assert.match(await err({ pane: 'file', path: 'x.ts' }, 'gone'), /No file at/);
  w.sent.length = 0;
  // a chat with no folder: no file can be checked against it
  assert.match(await err({ pane: 'file', path: '/etc/hosts' }, 'nofolder'), /not inside this session's working directory;/);
  assert.match(await err({ pane: 'file', path: 'a.ts' }, 'nofolder'), /not inside/);
  assert.equal(w.sent.length, 0);
});

test("close_pane asks the window, and a window that can't answer is reported, not taken for a change", async () => {
  const t = setup();
  const w = fakeWindow(1, t.ipcMain, { answer: (req) => ({ outcome: req.op === 'close_pane' ? 'closed' : 'x' }) });
  t.wins.push(w.win);
  t.show(1, ['c']);
  assert.deepEqual(await t.call('close_pane', { pane: 'preview' }), { changed: true, outcome: 'closed', said: 'Closed the preview pane.' });
  const shut = setup();
  shut.wins.push(fakeWindow(5, shut.ipcMain, { answer: () => ({ outcome: 'not_open' }) }).win);
  shut.show(5, ['c']);
  assert.deepEqual(await shut.call('close_pane', { pane: 'tasks' }), {
    changed: false,
    outcome: 'not_open',
    said: "The tasks pane isn't open; nothing changed.",
  });
  assert.deepEqual(w.sent.at(-1), ['window:layout', { op: 'close_pane', caller: 'c', chatId: null, pane: 'preview' }]);
  assert.match(String((await t.call('close_pane', { pane: 'nope' })).error?.message), /pane must be one of/);
  const quiet = setup();
  quiet.wins.push(fakeWindow(2, quiet.ipcMain, { answer: () => null }).win);
  quiet.show(2, ['c']);
  assert.equal((await quiet.call('close_pane', { pane: 'diff' })).error.code, 'no_reply');
  const gone = setup();
  gone.wins.push(fakeWindow(3, gone.ipcMain, { reload: true }).win);
  gone.show(3, ['c']);
  assert.equal((await gone.call('show_pane', { pane: 'diff' })).error.code, 'window_gone');
});

test('open_terminal_tab: the folder the user allows, once per folder and chat; a refusal or a gone window opens nothing', async () => {
  const t = setup();
  const w = fakeWindow(1, t.ipcMain, { answer: () => ({ outcome: 'opened', tab_id: 'terminal-9' }) });
  t.wins.push(w.win);
  t.show(1, ['c']);
  const opened = await t.call('open_terminal_tab', {});
  assert.deepEqual(opened, { changed: true, outcome: 'opened', said: SAID.opened(), tab_id: 'terminal-9' });
  assert.deepEqual(t.asked, [['c', { cwd: root }]]);
  assert.deepEqual(w.sent.at(-1), ['window:layout', { op: 'open_terminal', caller: 'c', chatId: null, cwd: root }]);
  // the same folder again: no second card; another folder asks
  await t.call('open_terminal_tab', { cwd: '.' });
  assert.equal(t.asked.length, 1);
  await t.call('open_terminal_tab', { cwd: 'src' });
  assert.deepEqual(t.asked.at(-1), ['c', { cwd: path.join(root, 'src') }]);
  // a folder that isn't there, or a file
  assert.match(String((await t.call('open_terminal_tab', { cwd: 'nope' })).error?.message), /No folder at/);
  assert.match(String((await t.call('open_terminal_tab', { cwd: 'src/a.ts' })).error?.message), /No folder at/);
  // a chat with no folder: only an absolute one
  t.show(1, ['c', 'nofolder']);
  assert.match(
    String((await t.call('open_terminal_tab', {}, 'nofolder')).error?.message),
    /no working directory: give cwd as an absolute folder/,
  );
  await t.call('open_terminal_tab', { cwd: root }, 'nofolder');
  assert.deepEqual(t.asked.at(-1), ['nofolder', { cwd: root }]);
  // the user declines: nothing opens, and the next call asks again
  const no = setup({ allow: false });
  const nw = fakeWindow(2, no.ipcMain);
  no.wins.push(nw.win);
  no.show(2, ['c']);
  assert.equal((await no.call('open_terminal_tab', {})).error.code, 'denied');
  assert.equal(nw.sent.length, 0);
  await no.call('open_terminal_tab', {});
  assert.equal(no.asked.length, 2);
  // two calls for one folder while its card waits share that card
  const two = setup();
  const tw = fakeWindow(6, two.ipcMain, { answer: () => ({ outcome: 'opened', tab_id: 'terminal-x' }) });
  two.wins.push(tw.win);
  two.show(6, ['c']);
  const pair = await Promise.all([two.call('open_terminal_tab', {}), two.call('open_terminal_tab', {})]);
  assert.deepEqual(
    pair.map((r: any) => r.outcome),
    ['opened', 'opened'],
  );
  assert.equal(two.asked.length, 1, 'one card for both');
  // the chat left the screen while the card waited: nothing opens, and the model hears why
  let leave = () => undefined as unknown;
  const left = setup({ onAsk: () => leave() });
  const lw = fakeWindow(3, left.ipcMain);
  left.wins.push(lw.win);
  left.show(3, ['c']);
  leave = () => left.show(3, []);
  assert.deepEqual(await left.call('open_terminal_tab', {}), { changed: false, outcome: 'not_on_screen', said: SAID.not_on_screen() });
  assert.equal(lw.sent.length, 0);
});
