// The computer-use tools for a chat that lives on a Host (G8 #3903): a stack per Host over a RemoteHelper, the routing by the chat's owner, the unattended refusal on the routed path, and no way back to this Mac's helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NOTES, rejects, ToolError } from './support/desktop-kit.ts';
import { recordingBroker } from './support/computer-tool-kit.ts';

const require = createRequire(import.meta.url);
const { createHostDesktop, buildStack, sandboxAttendance, appsOf } = require('../electron/capabilities/hostDesktop.cjs');
const { guarded } = require('../electron/capabilities/contract/actionGuard.cjs');

const chatCtx = (chatId: string) => ({ chatId });
/** A Host's desktop that answers the helper's requests like the real one, and records every request. */
function fakeRemote() {
  const log: any[] = [];
  const alive = { value: true };
  const remote = {
    lease: async (chat: string, apps: any) => void log.push(['lease', chat, apps]),
    release: async (chat: string) => void log.push(['release', chat]),
    abort: async (chat: string) => void log.push(['abort', chat]),
    state: async () => ({ available: true }),
    alive: () => alive.value,
    command: async (chat: string, method: string, params: any = {}) => {
      log.push(['command', chat, method, params]);
      if (method === 'apps.resolve')
        return { apps: params.queries.map((q: string) => ({ query: q, app: q === 'Notes' ? { ...NOTES, running: true } : null })) };
      if (method === 'screenshot')
        return {
          jpeg: 'JPEG',
          width: 1000,
          height: 500,
          pixelsPerPoint: 0.5,
          display: { id: 1, x: 0, y: 0, width: 2000, height: 1000 },
          mimeType: 'image/jpeg',
        };
      if (method === 'target.info') return NOTES;
      return { ok: true };
    },
  };
  return { remote, log, alive };
}

function world(over: { idle?: number | Error } = {}) {
  const r = fakeRemote();
  const { broker, asks } = recordingBroker({
    computerAccessSet: { decision: 'allow' },
    computerTakeover: { decision: 'allow' },
    computerConfirm: { decision: 'allow' },
  });
  const state: any = { idle: over.idle ?? 0, allowed: false, paused: [] as any[], stopped: [] as string[] };
  const session = { activeTurn: { human: true }, permission: 'default', scheduled: null };
  const deps = {
    grants: {
      forChat: () => [],
      deny: () => [],
      global: () => [],
      chat: () => [],
      briefForeground: () => false,
      rung: () => null,
      rememberRung: () => undefined,
    },
    broker,
    sessions: { get: () => session },
    controller: { isSubagentCall: () => false },
    kindOf: () => 'claude',
    anchorOf: () => 'ask' as const,
    userIdleSeconds: async () => {
      if (state.idle instanceof Error) throw state.idle;
      return state.idle;
    },
    unattendedAllowed: () => state.allowed,
    onUnattended: (chatId: string, e: any) => state.paused.push({ chatId, code: e.code }),
    onStop: (chatId: string) => state.stopped.push(chatId),
  };
  const local: string[] = [];
  const owners: Record<string, string | null> = { onHost: 'host-1', onMac: null, onOther: 'host-2' };
  const remotes: Record<string, any> = { 'host-1': r.remote };
  const hd = createHostDesktop({
    ownerOf: (c: string) => owners[c] ?? null,
    remoteFor: (h: string) => remotes[h] ?? null,
    grantsFor: () => deps.grants,
    nameOf: (h: string) => `Host ${h}`,
    deps,
  });
  const tools = hd.route(
    ['desktop_request_access', 'desktop_screenshot', 'desktop_left_click', 'desktop_nope'].map((name) => ({
      name,
      handler: async () => (local.push(name), [{ type: 'text', text: 'LOCAL' }]),
    })),
  );
  const tool = (name: string) => tools.find((t: any) => t.name === name);
  const run = (name: string, args: any, chatId: string) =>
    guarded({ token: { chat: chatId, turn: 1 } }, () => tool(name).handler(args, chatCtx(chatId)));
  return { ...r, state, hd, local, run, asks, owners, remotes, deps };
}

test('a chat on this Mac runs the tool it always did; a chat on a Host runs it in that Host’s stack and never on this Mac', async () => {
  const w = world();
  assert.equal((await w.run('desktop_screenshot', {}, 'onMac'))[0].text, 'LOCAL');
  assert.deepEqual(w.local, ['desktop_screenshot']);
  await w.run('desktop_request_access', { apps: ['Notes'], reason: 'test' }, 'onHost');
  await w.run('desktop_screenshot', {}, 'onHost');
  assert.deepEqual(w.local, ['desktop_screenshot'], 'nothing more ran on this Mac');
  assert.ok(
    w.log.some((l) => l[0] === 'command' && l[2] === 'screenshot'),
    'the screenshot was taken on the Host',
  );
  assert.equal(w.log.find((l) => l[0] === 'lease')?.[1], 'onHost');
});

test('a Host that is not connected answers with an error: there is no desktop to use, and nothing runs on this Mac instead', async () => {
  const w = world();
  await rejects(w.run('desktop_screenshot', {}, 'onOther'), 'not_connected', /not connected/);
  assert.deepEqual(w.local, []);
  assert.equal(w.log.length, 0);
});

test('a tool the Host stack does not have is a missing capability, never this Mac’s tool', async () => {
  const w = world();
  await rejects(w.run('desktop_nope', {}, 'onHost'), 'capability_missing', /isn't available on this chat's host/);
  assert.deepEqual(w.local, []);
});

test('unattended on the routed path: nobody at the user’s Mac is refused before any input reaches the Host, and the chat is paused', async () => {
  const w = world();
  await w.run('desktop_request_access', { apps: ['Notes'], reason: 'test' }, 'onHost');
  await w.run('desktop_screenshot', {}, 'onHost');
  const before = w.log.length;
  w.state.idle = 11 * 60;
  await rejects(w.run('desktop_left_click', { coordinate: [10, 10] }, 'onHost'), 'unattended', /switched off \(no input for 10 minutes\)/);
  assert.equal(w.log.slice(before).filter((l) => l[0] === 'command' && l[2] === 'input.click').length, 0, 'no click reached the Host');
  assert.deepEqual(w.state.paused, [{ chatId: 'onHost', code: 'unattended' }]);
  // the user's idle time cannot be read: the same refusal
  w.state.idle = new Error('powerMonitor unavailable');
  await rejects(w.run('desktop_left_click', { coordinate: [10, 10] }, 'onHost'), 'unattended');
  assert.equal(w.log.filter((l) => l[0] === 'command' && l[2] === 'input.click').length, 0);
  assert.deepEqual(w.local, [], 'this Mac’s tools were never involved');
});

test('the stack is built once per Host and kept across reconnects; Stop and a finished turn reach the Host the chat lives on', async () => {
  const w = world();
  await w.run('desktop_request_access', { apps: ['Notes'], reason: 'test' }, 'onHost');
  const first = w.hd.stack('host-1');
  assert.ok(first);
  await w.run('desktop_screenshot', {}, 'onHost');
  assert.equal(w.hd.stack('host-1'), first, 'the same stack for the same connection');
  await w.hd.abort('onHost');
  assert.deepEqual(w.log.at(-1), ['abort', 'onHost']);
  await w.hd.abort('onMac');
  await w.hd.abort('onOther');
  await w.hd.abort('nobody');
  assert.equal(w.log.filter((l) => l[0] === 'abort').length, 1, 'a chat on this Mac or an unconnected Host has nothing to stop on a Host');
  await w.hd.turnEnded('onHost', 3);
  assert.deepEqual(w.log.at(-1), ['release', 'onHost']);
  const quiet = w.log.length;
  await w.hd.turnEnded('onMac', 1);
  await w.hd.turnEnded('onOther', 1);
  assert.equal(w.log.length, quiet, 'a turn of a chat on this Mac or an unconnected Host asks no Host to let go');
  const lost: string[] = [];
  Object.assign(w.deps, { desktopTabs: { hostLost: (hostId: string) => lost.push(hostId) } });
  const second = fakeRemote();
  w.remotes['host-1'] = second.remote;
  await w.run('desktop_screenshot', {}, 'onHost');
  assert.equal(w.hd.stack('host-1'), first, 'a new connection to the same Host keeps the stack, so the chat keeps its grants');
  assert.deepEqual(
    second.log.filter((l) => l[0] === 'lease').map((l) => l[1]),
    ['onHost'],
    'and takes its lease again over the new connection',
  );
  assert.ok(second.log.some((l) => l[0] === 'command' && l[2] === 'screenshot'));
  assert.equal(w.hd.stack('nowhere'), null);
  assert.deepEqual(lost, ['host-1'], 'a direct router without a cursor callback still retires its desktop tabs');
});

test('sandboxAttendance: a person at their own Mac is present; a scheduled task, a sub-agent or a turn nobody started is not', async () => {
  const sessions: any = { c: { activeTurn: { human: true }, scheduled: null } };
  const controller = { isSubagentCall: (c: string, id?: string | null) => id === 'sub' };
  const present = sandboxAttendance({
    sessions: { get: (c: string) => sessions[c] },
    controller,
    kindOf: () => 'claude',
    userIdleSeconds: async () => 5,
  });
  assert.equal(await present('c', undefined), null);
  assert.equal(await present('c', { callId: 'sub' }), 'a sub-agent');
  sessions.c = { activeTurn: { human: true }, scheduled: { unattended: true } };
  assert.equal(await present('c', undefined), 'a scheduled task');
  sessions.c = { activeTurn: null, scheduled: null };
  assert.equal(await present('c', undefined), 'no turn you started');
  const basic = sandboxAttendance({
    sessions: { get: () => ({ activeTurn: null }) },
    controller,
    kindOf: () => 'acp:x',
    userIdleSeconds: async () => 0,
  });
  assert.equal(await basic('c', undefined), 'a tool call outside a prompt');
});

test('appsOf: the chat’s granted apps as a list for the Host, or none yet', () => {
  const grants = (ids: any[]) => ({ granted: () => new Map(ids.map((id, i) => [String(i), { bundleId: id }])) });
  assert.deepEqual(appsOf(grants(['a.b', 'c.d']))('c'), ['a.b', 'c.d']);
  assert.deepEqual(appsOf(grants([]))('c'), []);
  assert.deepEqual(appsOf(grants(['a.b', undefined]))('c'), ['a.b'], 'a grant with no bundle id is left out, never widened to any app');
});

test('buildStack makes no Mac-only pieces: no overlay, Esc, clipboard, teach tooltip, or hiding of this Mac’s windows', () => {
  const w = world();
  const stack = buildStack({ ...w.deps, remote: w.remote });
  assert.equal(stack.desktop.indicator, null);
  assert.equal(stack.desktop.host, null);
  assert.equal(stack.desktop.clipboard, null);
  assert.equal(stack.desktop.hideBeforeAction(), false);
  assert.ok(stack.handlers.has('desktop_screenshot'));
  assert.ok(stack.handlers.size > 10);
  assert.ok(ToolError);
});

test('a turn that ended lets the stack of the chat’s Host let go; a finished chat gives its Host’s desktop up at once, wherever it lived', async () => {
  const w = world();
  await w.run('desktop_request_access', { apps: ['Notes'], reason: 'test' }, 'onHost');
  await w.run('desktop_screenshot', {}, 'onHost');
  const stack = w.hd.stack('host-1');
  await w.hd.chatTurnEnded('onHost');
  assert.equal(stack.cu.controlling, null, 'the stack’s own desktop lock is let go');
  const before = w.log.length;
  await w.hd.chatTurnEnded('onMac');
  await w.hd.chatTurnEnded('onOther');
  assert.equal(w.log.length, before, 'a chat on this Mac or an unconnected Host asks no Host stack to clean up');
  // the chat is deleted: its ownership record may be gone already, so every stack is asked
  w.owners.onHost = null as any;
  await w.hd.forget('onHost');
  assert.deepEqual(w.log.at(-1), ['release', 'onHost']);
  const released = w.log.filter((l) => l[0] === 'release').length;
  await w.hd.forget('never-seen');
  assert.equal(w.log.filter((l) => l[0] === 'release').length, released, 'a chat that held nothing releases nothing');
});

test('forget survives a stack that fails', async () => {
  const w = world();
  await w.run('desktop_request_access', { apps: ['Notes'], reason: 'test' }, 'onHost');
  await w.run('desktop_screenshot', {}, 'onHost');
  w.remote.release = async () => {
    throw new Error('Host gone');
  };
  await w.hd.forget('onHost');
});

test('sandboxAttendance: the bench switch (a VM only) counts the user as present; one that cannot be read is off', async () => {
  const w = world();
  const mk = (benchAttended: () => Promise<boolean>) =>
    sandboxAttendance({
      sessions: w.deps.sessions,
      controller: w.deps.controller,
      kindOf: () => 'claude',
      userIdleSeconds: async () => 99 * 60,
      benchAttended,
    });
  assert.equal(await mk(async () => true)('c', {}), null, 'switched on: attended however long the user was away');
  assert.ok(await mk(async () => false)('c', {}), 'off: the idle time counts');
  assert.ok(
    await mk(async () => {
      throw new Error('probe failed');
    })('c', {}),
    'unreadable: off',
  );
});
