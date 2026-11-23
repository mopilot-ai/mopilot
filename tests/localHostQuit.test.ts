// Quitting with chats on this Mac's background Host (H2): they are listed apart, the one-line notice shows once, "Quit and stop them" stops them, and the sheet and the row tell the two kinds apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  summarize,
  summaryText,
  needsConfirm,
  isEmpty,
  ExitGate,
  createExitGate,
  emptySummary,
} = require('../electron/platform/exitGate.cjs');
const { createKeepsRunning } = require('../electron/host/keepsRunning.cjs');
const L = require('../electron/host/localHost.cjs');

const states: Record<string, any> = {
  app: { turn: 'running' },
  bg1: { turn: 'running' },
  bg2: { turn: 'awaitingUser' },
  idle: { turn: 'idle' },
};
const sum = (notice = true) => ({
  ...summarize({
    chats: Object.keys(states),
    get: (id: string) => states[id],
    kindOf: () => 'claude',
    keeps: (id: string) => id.startsWith('bg') || id === 'idle',
  }),
  notice,
});
const tmp = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keeps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('chats on the background Host are counted apart: the in-app question stays about in-app turns only', () => {
  const s = sum();
  assert.deepEqual(s.turns, ['app']);
  assert.deepEqual(s.keeps, ['bg1', 'bg2']);
  assert.equal(summaryText(s), '1 turn will stop. 2 chats keep running on this Mac.');
  assert.equal(summaryText({ ...s, turns: [] }), '2 chats keep running on this Mac.');
  assert.equal(summaryText({ ...s, turns: [], keeps: ['bg1'] }), '1 chat keeps running on this Mac.');
  assert.equal(summaryText({ ...s, notice: false }), '1 turn will stop.');
  assert.equal(summaryText({ ...emptySummary(), notice: true }), '');
  // they never make the app wait on its own: a quiet restart is not blocked by them
  assert.equal(isEmpty({ ...emptySummary(), keeps: ['bg1'] }), true);
  assert.equal(needsConfirm({ ...emptySummary(), keeps: ['bg1'], notice: true }, 'shortcut'), true);
  assert.equal(needsConfirm({ ...emptySummary(), keeps: ['bg1'], notice: false }, 'shortcut'), false);
  assert.equal(needsConfirm({ ...emptySummary(), keeps: ['bg1'], notice: true }, 'never'), false);
});

function gateFor(answer: unknown, s: any) {
  const log: string[] = [];
  const g = new ExitGate({
    collect: async () => s,
    confirm: async (x: any) => (log.push(`ask ${summaryText(x)}`), answer),
    confirmClose: () => 'shortcut',
    noticed: () => log.push('noticed'),
    stopKeeps: async (ids: string[]) => void log.push(`stop ${ids}`),
  });
  return { g, log };
}

test('Quit leaves them running and Quit and stop them stops them; Cancel changes nothing', async () => {
  let r = gateFor(true, sum());
  assert.equal(await r.g.request('quit'), true);
  assert.deepEqual(r.log, ['ask 1 turn will stop. 2 chats keep running on this Mac.', 'noticed']);
  r = gateFor('stop', sum());
  assert.equal(await r.g.request('quit'), true);
  assert.deepEqual(r.log.slice(1), ['noticed', 'stop bg1,bg2']);
  r = gateFor(false, sum());
  assert.equal(await r.g.request('quit'), false);
  assert.deepEqual(r.log.length, 1);
  // shown once: with the notice seen, only in-app turns ask, and nothing more is recorded
  r = gateFor(true, sum(false));
  await r.g.request('quit');
  assert.deepEqual(r.log, ['ask 1 turn will stop.']);
  r = gateFor(true, { ...emptySummary(), keeps: ['bg1'], notice: false });
  assert.equal(await r.g.request('quit'), true);
  assert.deepEqual(r.log, []);
  // no stop hook: stopping is a no-op
  const bare = new ExitGate({ collect: async () => sum(), confirm: async () => 'stop', confirmClose: () => 'shortcut' });
  assert.equal(await bare.request('quit'), true);
});

function wired(over: any = {}) {
  const sent: any[] = [];
  const kr = over.kr ?? {
    owns: (id: string) => id.startsWith('bg'),
    seen: () => over.seen ?? false,
    markSeen: () => sent.push('seen'),
    stop: async (ids: string[]) => void sent.push(`stop ${ids}`),
  };
  const ipcMain = new EventEmitter();
  const wc = Object.assign(new EventEmitter(), {
    send: (ch: string, id: number, payload: any) => {
      sent.push(payload);
      ipcMain.emit(`${ch}:reply`, {}, id, over.answer ?? 'stop');
    },
  });
  const boxes: any[] = [];
  const gate = createExitGate({
    ipcMain,
    dialog: { showMessageBox: async (b: any) => (boxes.push(b), { response: over.response ?? 1 }), showErrorBox: () => undefined },
    window: () => (over.noWindow ? null : { show: () => undefined, focus: () => undefined, webContents: wc }),
    sessions: () => ({ all: () => Object.keys(states), get: (id: string) => states[id] }),
    controller: () => ({ ref: () => ({ kind: 'claude', key: 'k' }) }),
    codex: () => null,
    claude: () => null,
    prefs: () => ({ confirmClose: 'shortcut' }),
    keepsRunning: () => kr,
  });
  return { gate, sent, boxes };
}

test('the window sheet carries the count and the answer "stop" stops them; the native sheet offers the same three choices', async () => {
  const w = wired();
  assert.equal(await w.gate.request('quit'), true);
  assert.equal(w.sent[0].keeps, 2);
  assert.equal(w.sent[0].text, '1 turn will stop. 2 chats keep running on this Mac.');
  assert.deepEqual(w.sent.slice(1), ['seen', 'stop bg1,bg2']);
  const n = wired({ noWindow: true, response: 1 });
  assert.equal(await n.gate.request('quit'), true);
  assert.deepEqual(n.boxes[0].buttons, ['Quit', 'Quit and stop them', 'Cancel']);
  assert.equal(n.boxes[0].cancelId, 2);
  assert.deepEqual(n.sent, ['seen', 'stop bg1,bg2']);
  const c = wired({ noWindow: true, response: 2 });
  assert.equal(await c.gate.request('quit'), false);
  // seen already, or no background Host: the sheet is today's
  const old = wired({ noWindow: true, seen: true, response: 0 });
  assert.equal(await old.gate.request('quit'), true);
  assert.deepEqual(old.boxes[0].buttons, ['Quit', 'Cancel']);
  const none = wired({ noWindow: true, kr: null, response: 0 });
  assert.equal(await none.gate.request('quit'), true);
  const idleOnly = createExitGate({
    ...({} as any),
    ipcMain: new EventEmitter(),
    dialog: {},
    sessions: () => ({ all: () => [], get: () => null }),
    controller: () => null,
    codex: () => null,
    claude: () => null,
    prefs: () => ({}),
  });
  assert.equal(await idleOnly.request('quit'), true);
});

test('the notice is remembered in a file of its own, and a stop that fails does not hold the quit', async (t) => {
  const dir = tmp(t);
  const stopped: string[] = [];
  const k = createKeepsRunning({
    dir,
    runsHere: (id: string) => {
      if (id === 'boom') throw new Error('no ownership file');
      return id === 'bg1';
    },
    stopChat: (id: string) => {
      stopped.push(id);
      if (id === 'bad') return Promise.reject(new Error('gone'));
      return undefined;
    },
  });
  assert.equal(k.owns('bg1'), true);
  assert.equal(k.owns('app'), false);
  assert.equal(k.owns('boom'), false);
  assert.equal(k.seen(), false);
  k.markSeen();
  assert.equal(k.seen(), true);
  await k.stop(['bad', 'ok']);
  assert.deepEqual(stopped, ['bad', 'ok']);
  // a folder that cannot be written to: remembered nowhere, never thrown
  const file = path.join(dir, 'a-file');
  fs.writeFileSync(file, '');
  createKeepsRunning({ dir: file, runsHere: () => false, stopChat: () => undefined }).markSeen();
});

test('registering this Mac’s Host gives the quit sheet its chats and the stop goes to the background Host', async (t) => {
  const dir = tmp(t);
  const handlers = new Map<string, any>();
  const live: any = {};
  const stops: string[] = [];
  let host: any = { stop: (id: string) => stops.push(id) };
  const reg = L.registerLocalHost({
    handle: (c: string, fn: any) => handlers.set(c, fn),
    service: () => ({ hostFor: (id: string) => (id === L.LOCAL_ID ? host : null) }),
    enabled: () => true,
    deps: { live, app: { getPath: () => dir } },
    allowed: () => true,
  });
  assert.equal(live.keepsRunning.owns('some-chat'), false);
  await live.keepsRunning.stop(['c1']);
  host = null;
  await live.keepsRunning.stop(['c2']);
  assert.deepEqual(stops, ['c1']);
  reg.dispose();
  // the gate defaults open for a caller that names none
  const bare: any = { keepsRunning: null };
  L.registerLocalHost({
    handle: () => undefined,
    service: () => ({}),
    enabled: () => true,
    deps: { live: bare, app: { getPath: () => dir } },
  });
  assert.equal(bare.keepsRunning.owns('x'), false);
  // without the app's wiring only the calls are registered
  L.registerLocalHost({ handle: () => undefined, service: () => ({}), enabled: () => true });
});
