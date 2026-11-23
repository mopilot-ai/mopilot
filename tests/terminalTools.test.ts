// The chat's terminal tools (electron/capabilities/tools/terminalTools.cjs, registered by paneTools.cjs): a command is typed
// only into a tab this chat opened and the user has not typed in, only after the user allowed that exact line (a full-access
// chat is not asked, a read-only one never runs it); output is the pty's own tail; stop sends Ctrl-C or closes the tab.
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
const { TerminalTabs, commandOf, plain, lastLines } = require('../electron/capabilities/tools/terminalTools.cjs');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-tools-')));

type Pty = { tail: string; outputAt: number; typed: boolean; running: boolean };

function setup(
  over: {
    anchor?: string;
    allowCommand?: boolean;
    open?: (req: any) => any;
    close?: string;
    noCommandCard?: boolean;
    quiet?: boolean;
    onAsk?: () => void;
    realTime?: boolean;
  } = {},
) {
  const ipcMain = new EventEmitter();
  const viewedBy = new Map<number, any>();
  const ptys = new Map<string, Pty>();
  const writes: Array<[string, string]> = [];
  const sent: any[] = [];
  const asked: any[] = [];
  let clock = 1_000_000;
  const hooks: { onSleep?: () => void } = {};
  let opened = 0;
  const wc: any = Object.assign(new EventEmitter(), {
    id: 7,
    isCrashed: () => false,
    send: (channel: string, rid: number, req: any) => {
      sent.push(req);
      let reply: any = { outcome: 'shown' };
      if (req.op === 'open_terminal') {
        const tab = `term-${++opened}`;
        if (!over.quiet) ptys.set(`wc7:${tab}`, { tail: '$ ', outputAt: clock - 1000, typed: false, running: false });
        else ptys.set(`wc7:${tab}`, { tail: '', outputAt: clock, typed: false, running: false });
        reply = over.open ? over.open(req) : { outcome: 'opened', tab_id: tab };
      } else if (req.op === 'close_terminal') reply = { outcome: over.close ?? 'closed' };
      queueMicrotask(() => ipcMain.emit(`${channel}:reply`, {}, rid, reply));
    },
  });
  const win = { webContents: wc, isDestroyed: () => false, isFocused: () => true };
  const wins: any[] = [win];
  viewedBy.set(7, { visible: ['c'], primary: 'c', focused: 'c' });
  const r = new Registry();
  r.setApprover(async () => true);
  const dispose = registerPaneTools(r, {
    owner: (ctx: any) => (ctx.segmentId === 'seg' ? ctx.chatId : null),
    viewedBy,
    windows: () => wins,
    projectOf: async () => root,
    approveTerminal: async () => true,
    ...(over.noCommandCard
      ? {}
      : {
          approveCommand: async (chatId: string, signal: any, req: any) => {
            assert.ok(signal instanceof AbortSignal);
            asked.push([chatId, req]);
            over.onAsk?.();
            return over.allowCommand ?? true;
          },
        }),
    anchorOf: () => over.anchor ?? 'ask',
    pty: {
      info: (k: string) => (ptys.has(k) ? { ...ptys.get(k)! } : null),
      write: (k: string, d: string) => void writes.push([k, d]),
    },
    ...(over.realTime
      ? {}
      : {
          now: () => clock,
          sleep: async (ms: number) => {
            clock += ms;
            hooks.onSleep?.();
          },
        }),
    ipcMain,
    replyMs: 1000,
  });
  const callNow = async (tool: string, args: any, chat = 'c') => {
    const res = await r.invoke(chat, 'seg', tool, args);
    return res.ok ? JSON.parse(res.content[0].text) : { error: res.error };
  };
  // each call comes a while after the last, as a model's turns do
  const call = (tool: string, args: any, chat = 'c') => {
    if (!over.realTime) clock += 5000;
    return callNow(tool, args, chat);
  };
  return {
    r,
    ptys,
    writes,
    sent,
    asked,
    call,
    callNow,
    dispose,
    hooks,
    unview: () => viewedBy.delete(7),
    moveTo: (id: number) => {
      viewedBy.delete(7);
      viewedBy.set(id, { visible: ['c'], primary: 'c', focused: 'c' });
      wins.push({
        webContents: { id, isCrashed: () => false, on: () => {}, send: () => {} },
        isDestroyed: () => false,
        isFocused: () => true,
      });
    },
    tick: () => {
      clock += 5;
    },
    now: () => clock,
  };
}

test('the tools are registered beside the pane tools', () => {
  const t = setup();
  assert.deepEqual(
    t.r.list().map((x: any) => x.name),
    ['show_pane', 'close_pane', 'open_terminal_tab', 'run_in_terminal', 'read_terminal', 'stop_terminal_tab'],
  );
  t.dispose();
});

test('run_in_terminal opens a tab, asks for the exact line, types it, and reuses the tab for the next command', async () => {
  const t = setup();
  const out = await t.call('run_in_terminal', { command: '  npm test  ' });
  assert.equal(out.changed, true);
  assert.equal(out.tab_id, 'term-1');
  assert.equal(out.cwd, root);
  assert.deepEqual(t.asked, [['c', { cwd: root, command: 'npm test' }]]);
  assert.deepEqual(t.writes, [['wc7:term-1', 'npm test\r']]);
  assert.deepEqual(t.sent[0], { op: 'open_terminal', caller: 'c', chatId: null, cwd: root });
  // the shell is back at its prompt: the next command goes to the same tab, and is asked about again
  await t.call('run_in_terminal', { command: 'ls', tab_id: 'term-1' });
  assert.equal(t.asked.length, 2);
  assert.deepEqual(t.writes.at(-1), ['wc7:term-1', 'ls\r']);
  assert.equal(t.sent.filter((s) => s.op === 'open_terminal').length, 1, 'no second tab');
  t.dispose();
});

test('a full-access chat is not asked; a read-only one never runs a command; a refusal types nothing', async () => {
  const full = setup({ anchor: 'full' });
  assert.equal((await full.call('run_in_terminal', { command: 'pwd' })).changed, true);
  assert.deepEqual(full.asked, []);
  const ro = setup({ anchor: 'readOnly' });
  assert.equal((await ro.call('run_in_terminal', { command: 'pwd' })).error.code, 'read_only');
  assert.deepEqual([ro.sent, ro.asked, ro.writes], [[], [], []]);
  const no = setup({ allowCommand: false });
  const denied = await no.call('run_in_terminal', { command: 'rm -rf x' });
  assert.equal(denied.error.code, 'denied');
  assert.deepEqual(no.writes, []);
  assert.equal(no.sent.length, 0, 'no tab is opened before the user allowed the line');
  // no way to ask: refused, not run
  const mute = setup({ noCommandCard: true });
  assert.equal((await mute.call('run_in_terminal', { command: 'pwd' })).error.code, 'denied');
  [full, ro, no, mute].forEach((x) => x.dispose());
});

test('run_in_terminal refuses a bad line, a bad combination, a tab that is not the chat’s, and a chat on no screen', async () => {
  const t = setup();
  for (const command of [undefined, '', '   ', 'a\nb', 'a\u001b[2Jb', 'x'.repeat(4001)])
    assert.equal((await t.call('run_in_terminal', { command })).error.code, 'bad_args', String(command).slice(0, 10));
  assert.equal((await t.call('run_in_terminal', { command: 'ls', tab_id: 'term-1', cwd: root })).error.code, 'bad_args');
  const foreign = await t.call('run_in_terminal', { command: 'ls', tab_id: 'term-9' });
  assert.equal(foreign.error.code, 'not_found');
  assert.match(foreign.error.message, /user's own tabs are theirs/);
  assert.equal((await t.call('run_in_terminal', { command: 'ls', cwd: path.join(root, 'nope') })).error.code, 'not_found');
  assert.deepEqual([t.asked, t.writes], [[], []]);
  t.unview();
  assert.deepEqual(await t.call('run_in_terminal', { command: 'ls' }), {
    changed: false,
    outcome: 'not_on_screen',
    said: SAID.not_on_screen(),
  });
  t.dispose();
});

test('a tab the user typed in, or that runs something, or is gone, gets nothing typed', async () => {
  const t = setup();
  await t.call('run_in_terminal', { command: 'one' });
  const pty = t.ptys.get('wc7:term-1')!;
  t.writes.length = 0;
  pty.running = true;
  assert.equal((await t.call('run_in_terminal', { command: 'two', tab_id: 'term-1' })).error.code, 'busy');
  pty.running = false;
  pty.typed = true;
  assert.equal((await t.call('run_in_terminal', { command: 'two', tab_id: 'term-1' })).error.code, 'user_typed');
  assert.equal((await t.call('stop_terminal_tab', { tab_id: 'term-1' })).error.code, 'user_typed');
  assert.equal((await t.call('read_terminal', {})).running, false, 'reading is not acting: a tab the user typed in can still be read');
  assert.deepEqual(t.writes, []);
  // the shell exits, or the user closes the tab: gone, and forgotten
  t.ptys.delete('wc7:term-1');
  assert.equal((await t.call('run_in_terminal', { command: 'two', tab_id: 'term-1' })).error.code, 'gone');
  assert.equal((await t.call('read_terminal', { tab_id: 'term-1' })).error.code, 'not_found');
  t.dispose();
});

test('overlapping calls, and the tab changing while the card is open, are caught after the card', async () => {
  const t = setup();
  await t.call('run_in_terminal', { command: 'one' });
  t.writes.length = 0;
  const first = t.call('run_in_terminal', { command: 'two', tab_id: 'term-1' });
  // a second call for the same tab while the first waits on its card
  assert.equal((await t.call('run_in_terminal', { command: 'three', tab_id: 'term-1' })).error.code, 'in_use');
  await first;
  assert.deepEqual(t.writes, [['wc7:term-1', 'two\r']]);
  t.dispose();
  for (const [change, code] of [
    [(p: Pty) => (p.typed = true), 'user_typed'],
    [(p: Pty) => (p.running = true), 'busy'],
  ] as const) {
    let ptyOf: () => Pty | undefined = () => undefined;
    const u = setup({ onAsk: () => ptyOf() && change(ptyOf()!) });
    await u.call('run_in_terminal', { command: 'one' });
    ptyOf = () => u.ptys.get('wc7:term-1');
    u.writes.length = 0;
    assert.equal((await u.call('run_in_terminal', { command: 'two', tab_id: 'term-1' })).error.code, code);
    assert.deepEqual(u.writes, []);
    u.dispose();
  }
});

test('the user typing in a new tab while its shell starts, or the chat leaving the screen during the card', async () => {
  const typing = setup({ quiet: true });
  typing.hooks.onSleep = () => {
    const p = typing.ptys.get('wc7:term-1')!;
    Object.assign(p, { tail: '$ ', outputAt: 0, typed: true });
  };
  assert.equal((await typing.call('run_in_terminal', { command: 'x' })).error.code, 'user_typed');
  assert.deepEqual(typing.writes, []);
  const away: { unview?: () => void } = {};
  const t = setup({ onAsk: () => away.unview?.() });
  away.unview = t.unview;
  const res = await t.call('run_in_terminal', { command: 'ls' });
  assert.equal(res.outcome, 'not_on_screen');
  assert.deepEqual(t.writes, []);
  typing.dispose();
  t.dispose();
});

test('a new tab whose shell never reaches a prompt gets nothing typed; a window that opens nothing is reported', async () => {
  const slow = setup({ quiet: true });
  const res = await slow.call('run_in_terminal', { command: 'ls' });
  assert.equal(res.error.code, 'not_ready');
  assert.match(res.error.message, /Did NOT type the command/);
  assert.match(res.error.message, /"close": true/);
  assert.deepEqual(slow.writes, []);
  const none = setup({ open: () => ({ outcome: 'no_terminal' }) });
  assert.deepEqual(await none.call('run_in_terminal', { command: 'ls' }), {
    changed: false,
    outcome: 'no_terminal',
    said: 'No terminal tab was opened, so nothing was typed.',
  });
  const noId = setup({ open: () => ({ outcome: 'opened' }) });
  assert.equal((await noId.call('run_in_terminal', { command: 'ls' })).changed, false);
  [slow, none, noId].forEach((x) => x.dispose());
});

test('read_terminal: plain recent lines of the chat’s own tab, bounded, waiting for new output when asked', async () => {
  const t = setup();
  assert.equal((await t.call('read_terminal', {})).error.code, 'no_terminal');
  await t.call('run_in_terminal', { command: 'build' });
  const pty = t.ptys.get('wc7:term-1')!;
  pty.tail = '\u001b[32m$\u001b[0m build\r\nstep 1\r\nprogress 10%\rprogress 100%\r\nline 4\n';
  assert.deepEqual(await t.call('read_terminal', {}), { tab_id: 'term-1', running: false, text: '$ build\nstep 1\nprogress 100%\nline 4' });
  assert.equal((await t.call('read_terminal', { tab_id: 'term-1', lines: 2 })).text, 'progress 100%\nline 4');
  assert.equal((await t.call('read_terminal', { lines: 0 })).text, 'line 4', 'at least one line');
  // output arriving while it waits ends the wait early; none ends it at the limit
  const before = t.now();
  t.hooks.onSleep = () => {
    pty.tail += 'done\n';
    pty.outputAt = t.now();
  };
  const waited = await t.callNow('read_terminal', { wait_for_output_ms: 5000 });
  assert.match(waited.text, /done$/);
  assert.ok(t.now() - before < 1000);
  t.hooks.onSleep = undefined;
  const start = t.now();
  await t.callNow('read_terminal', { wait_for_output_ms: 99999 });
  assert.equal(t.now() - start >= 10000 && t.now() - start < 10100, true, 'capped at 10 s');
  const zero = t.now();
  await t.callNow('read_terminal', { wait_for_output_ms: -5 });
  assert.equal(t.now(), zero, 'a negative wait is no wait');
  t.dispose();
});

test('stop_terminal_tab: Ctrl-C then the state, or close through the window; never another’s tab', async () => {
  const t = setup();
  await t.call('run_in_terminal', { command: 'server' });
  const pty = t.ptys.get('wc7:term-1')!;
  t.writes.length = 0;
  pty.tail = '$ server\nlistening\n';
  pty.running = true;
  const still = await t.call('stop_terminal_tab', { tab_id: 'term-1' });
  assert.deepEqual(t.writes, [['wc7:term-1', '\u0003']]);
  assert.deepEqual(still, { changed: true, state: 'running', tail: '$ server\nlistening' });
  pty.running = false;
  assert.equal((await t.call('stop_terminal_tab', { tab_id: 'term-1' })).state, 'idle');
  assert.equal((await t.call('stop_terminal_tab', { tab_id: 'nope' })).error.code, 'not_found');
  // close: the window closes the tab, which ends its shell
  const closed = await t.call('stop_terminal_tab', { tab_id: 'term-1', close: true });
  assert.deepEqual(closed, { changed: true, state: 'closed', tail: '$ server\nlistening' });
  assert.deepEqual(t.sent.at(-1), { op: 'close_terminal', caller: 'c', chatId: null, tabId: 'term-1' });
  assert.equal((await t.call('stop_terminal_tab', { tab_id: 'term-1', close: true })).error.code, 'not_found', 'forgotten once closed');
  t.dispose();
});

test('closing: a window that has no such tab, another answer, or no window', async () => {
  const gone = setup({ close: 'no_tab' });
  await gone.call('run_in_terminal', { command: 'a' });
  assert.equal((await gone.call('stop_terminal_tab', { tab_id: 'term-1', close: true })).error.code, 'gone');
  const other = setup({ close: 'not_focused' });
  await other.call('run_in_terminal', { command: 'a' });
  assert.deepEqual(await other.call('stop_terminal_tab', { tab_id: 'term-1', close: true }), {
    changed: false,
    outcome: 'not_focused',
    said: 'Terminal tab "term-1" was not closed.',
  });
  other.unview();
  assert.equal((await other.call('stop_terminal_tab', { tab_id: 'term-1', close: true })).outcome, 'not_on_screen');
  gone.dispose();
  other.dispose();
});

test('a tab opened with open_terminal_tab is the chat’s too', async () => {
  const t = setup();
  assert.equal((await t.call('open_terminal_tab', {})).outcome, 'opened');
  await t.call('run_in_terminal', { command: 'ls', tab_id: 'term-1' });
  assert.deepEqual(t.writes, [['wc7:term-1', 'ls\r']]);
  t.dispose();
});

test('helpers: one clean line, plain output, last lines, the chat’s tabs', () => {
  assert.equal(commandOf(' ls '), 'ls');
  assert.equal(plain('a\u001b]0;title\u0007b\u001b]8;;x\u001b\\c\u001b[?25h\u001b(Bd\u0007e\u0001'), 'abcde');
  assert.equal(plain('x\r\r\ny\r'), 'x\ny');
  assert.equal(plain('lss\b\b\b\bls -l'), 'ls -l', 'backspaces erase what was typed');
  assert.equal(plain('\b\bab'), 'ab', 'a backspace at the start of a line erases nothing');
  assert.equal(lastLines('a\nb\nc\n\n', 2), 'b\nc');
  assert.equal(lastLines('x'.repeat(30000), 5).length, 20000);
  const tabs = new TerminalTabs();
  assert.equal(tabs.get('c'), null);
  tabs.opened('c', 1, 'a', '/x');
  tabs.opened('c', 1, 'b', '/y');
  assert.equal(tabs.get('c')?.tabId, 'b');
  assert.equal(tabs.get('c', 'a')?.key, 'wc1:a');
  assert.equal(tabs.get('c', 'zz'), null);
  tabs.forget('c', 'a');
  tabs.forget('c', 'b');
  tabs.forget('c', 'b');
  tabs.forget('other', 'b');
  assert.equal(tabs.get('c'), null);
});

test('with the real clock, a command is typed and a tab is stopped', async () => {
  const t = setup({ realTime: true });
  assert.equal((await t.call('run_in_terminal', { command: 'ls' })).changed, true);
  assert.equal((await t.call('stop_terminal_tab', { tab_id: 'term-1' })).state, 'idle');
  t.dispose();
});

test('commandOf refuses what is not a string', () => {
  assert.throws(() => commandOf(5), /non-empty/);
});

test('a command just typed counts as running until the shell has had time to start it', async () => {
  const t = setup();
  await t.call('run_in_terminal', { command: 'npm run dev' });
  const quick = await t.callNow('run_in_terminal', { command: 'ls', tab_id: 'term-1' });
  assert.equal(quick.error.code, 'busy');
  assert.equal((await t.call('run_in_terminal', { command: 'ls', tab_id: 'term-1' })).changed, true);
  t.dispose();
});

test('closing a tab is asked of the window that opened it only', async () => {
  const t = setup();
  await t.call('run_in_terminal', { command: 'a' });
  t.moveTo(8);
  const res = await t.call('stop_terminal_tab', { tab_id: 'term-1', close: true });
  assert.equal(res.outcome, 'other_window');
  assert.equal(
    t.sent.some((s) => s.op === 'close_terminal'),
    false,
  );
  t.dispose();
});
