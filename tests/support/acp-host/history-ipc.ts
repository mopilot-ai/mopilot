// ACP host history-ipc unit cases with shared fake-agent and transcript fixtures.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { acp, dir, settle, until, KEY, CWD, setup, fakeProc, INIT } from './fixture';

export function registerHistoryIpcCases() {
  test('list, search, rename and remove read and write the transcripts', async () => {
    const t = setup();
    const a = 'acp:fake:a';
    t.items.append(
      a,
      { t: 'session', sessionId: 's', cwd: '/a', at: 5 },
      { t: 'user', user: { content: [null, 42, [], { type: 'text', text: 'Fix the parser' }, { type: 'image' }] } },
      { t: 'title', name: 'Old' },
      // the agent lost the session and MoPilot opened a new one: its CLI resumes the latest
      { t: 'session', sessionId: 's-new', cwd: '/a', at: 9 },
    );
    t.host.rename(a, `${'y'.repeat(199)}🙂`);
    assert.equal((await t.host.history(a)).at(-1).name, 'y'.repeat(199), 'a long name is cut before the emoji');
    t.host.rename(a, 'Parser work');
    t.host.rename(a, 3);
    t.host.rename('nope', 'x');
    t.items.append('acp:fake:b', { t: 'session', cwd: '/b' }, { t: 'update', update: { text: 'the "quoted" needle' } });
    t.items.append('acp:fake:nosession', { t: 'user' });
    t.items.append('notacp', { t: 'session' });
    const list = await t.host.list();
    assert.deepEqual(list.map((c: any) => c.id).sort(), ['acp:fake:a', 'acp:fake:b']);
    const ca = list.find((c: any) => c.id === a);
    assert.deepEqual([ca.preview, ca.name, ca.createdAt, ca.cwd, ca.sessionId], ['Fix the parser', 'Parser work', 5, '/a', 's-new']);
    const cb = list.find((c: any) => c.id === 'acp:fake:b');
    assert.deepEqual([cb.preview, cb.name, cb.createdAt, cb.sessionId], ['', null, cb.updatedAt, null]);
    assert.deepEqual(await t.host.search('  '), []);
    assert.deepEqual(await t.host.search(undefined), []);
    assert.deepEqual(
      (await t.host.search('PARSER')).map((c: any) => c.id),
      [a],
    );
    assert.deepEqual(
      (await t.host.search('"quoted"')).map((c: any) => c.id),
      ['acp:fake:b'],
    );
    assert.equal((await t.host.search('e', 1)).length, 1);
    // a transcript that can't be read is searched by its title only
    const file = t.items.file('acp:fake:b');
    t.host.items = Object.assign(Object.create(t.items), { file: () => path.join(dir, 'missing') });
    assert.deepEqual(await t.host.search('needle'), []);
    t.host.items = t.items;
    assert.ok(fs.existsSync(file));
    assert.deepEqual((await t.host.history(a)).at(-1).name, 'Parser work');
    t.host.remove('nope');
    t.host.remove(a);
    assert.deepEqual(await t.host.history(a), []);
  });

  test('the person’s name for a chat on a machine is kept here first and then goes to its machine; an automatic title and a chat that runs here never do', async () => {
    const told: any[] = [];
    let answer: Promise<unknown> | null = Promise.resolve({ name: 'x' });
    const t = setup({ remoteRename: (key: string, name: string) => (told.push([key, name]), answer) });
    const a = 'acp:host-claude:m1';
    t.items.append(a, { t: 'session', sessionId: 'host:m1', cwd: '/srv', at: 5 });
    // the person's name: the record first, then the machine; the promise is the machine's answer
    assert.deepEqual(await t.host.rename(a, ' Mine '), { name: 'x' });
    assert.deepEqual(told, [[a, ' Mine ']]);
    assert.equal((await t.host.history(a)).at(-1).name, ' Mine ');
    // a machine that is away rejects, and the Mac still holds the name
    answer = Promise.reject(new Error('Can’t reach the machine'));
    await assert.rejects(t.host.rename(a, 'Kept'), { message: 'Can’t reach the machine' });
    assert.equal((await t.host.history(a)).at(-1).name, 'Kept');
    // an automatic title is the app's own, never sent; a chat that runs here is told to nobody (the hook answers null)
    answer = null;
    assert.equal(t.host.rename(a, 'Auto', true), null);
    assert.equal(t.host.rename(a, 'Local'), null);
    assert.equal(t.host.rename('nope', 'x'), null);
    assert.equal(t.host.rename(a, 5), null);
    assert.deepEqual(
      told.map((x) => x[1]),
      [' Mine ', 'Kept', 'Local'],
    );
    assert.equal((await t.host.history(a)).at(-1).name, 'Local');
    assert.equal((await t.host.history(a)).find((r: any) => r.name === 'Auto').auto, true);
    // an app with no machines never has the hook
    assert.equal(setup().host.remoteRename('k', 'n'), null);
  });

  test('close lets go of a session (session/close when the agent has it); closeAll stops every agent', async () => {
    const t = setup({
      handlers: {
        initialize: () => INIT({ sessionCapabilities: { close: {} } }),
        'session/close': () => {
          throw new Error('x');
        },
      },
    });
    t.host.close('acp:fake:none');
    const chat = await t.host.ensure(KEY, { cwd: CWD });
    t.host.terminals.create(chat, { command: 'sh' });
    t.host.close(KEY);
    await settle();
    assert.ok(t.sp.procs[0].received.some((m: any) => m.method === 'session/close'));
    assert.equal(t.host.terminals.byId.size, 0);
    assert.deepEqual(t.ended, [KEY]);
    // a chat that never got a session, without tools
    const u = setup({ tools: null });
    u.host.chats.set(KEY, { key: KEY });
    u.host.close(KEY);
    assert.equal(u.host.chats.size, 0);
    // closeAll: open chats closed, running agents killed, failed ones ignored
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const w = setup();
      await w.host.ensure(KEY, { cwd: CWD });
      const failed = Promise.reject(new Error('x'));
      failed.catch(() => {});
      w.host.agents.set('broken', failed);
      w.host.closeAll();
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(w.host.chats.size, 0);
      assert.equal(w.host.agents.size, 0);
      assert.equal(w.sp.procs[0].stdin.ended, true);
    } finally {
      mock.timers.reset();
    }
  });

  test('deleting a chat mid-turn stops the agent and its late answer cannot bring the transcript back', async () => {
    let release!: (v: any) => void;
    const t = setup({ handlers: { 'session/prompt': () => new Promise((r) => (release = r)) } });
    await t.host.send(KEY, { cwd: CWD, blocks: [{ type: 'text', text: 'edit everything' }] });
    await until(() => release);
    // a Stop that was escalating is let go with the chat
    t.host.cancel(KEY);
    t.host.remove(KEY);
    const cancels = t.sp.procs[0].notes.filter((n: any) => n.method === 'session/cancel');
    assert.equal(cancels.length, 2, 'the agent is told to stop working for a chat that is gone');
    // the turn ends as a Stop at once, so the controller does not wait on a chat that is gone
    assert.deepEqual(
      t.events.filter((e) => e.kind === 'turnEnd').map((e) => [e.stopReason, e.error]),
      [['cancelled', null]],
    );
    release({ stopReason: 'end_turn' });
    await settle();
    assert.equal(fs.existsSync(t.items.file(KEY)), false, 'no end record re-creates the deleted transcript');
    assert.equal(t.events.filter((e) => e.kind === 'turnEnd').length, 1, 'the late answer ends nothing again');
    // a chat that never got a session has no agent to tell
    t.host.chats.set(KEY, { key: KEY, prompting: { turnId: 'x' } });
    t.host.close(KEY);
    assert.equal(t.host.chats.size, 0);
  });

  test('retiring an archived chat: an idle session closes now, a running one after its turn, other chats stay', async () => {
    let release!: (v: any) => void;
    const t = setup({ handlers: { 'session/prompt': () => new Promise((r) => (release = r)) } });
    const other = 'acp:fake:other';
    await t.host.ensure(KEY, { cwd: CWD, chatId: 'c1' });
    await t.host.ensure(other, { cwd: CWD, chatId: 'c2' });
    assert.equal(t.host.retireChat('c1'), 1);
    assert.deepEqual([t.host.chats.has(KEY), t.host.chats.has(other)], [false, true]);
    assert.ok(t.events.every((e) => e.kind !== 'turnEnd'));
    // running: its turn finishes, then the session goes
    await t.host.send(other, { blocks: [] }, { chatId: 'c2' });
    await until(() => release);
    assert.equal(t.host.retireChat('c2'), 0);
    assert.equal(t.host.chats.has(other), true);
    release({ stopReason: 'end_turn' });
    await until(() => t.kinds().includes('turnEnd'));
    assert.equal(t.host.chats.has(other), false);
    // still opening (no session yet): after its turn too; a chat with nothing open retires nothing
    const opening = { key: 'acp:fake:opening', chatId: 'c3', sessionId: null, prompting: null };
    t.host.chats.set(opening.key, opening);
    assert.equal(t.host.retireChat('c3'), 0);
    assert.equal((opening as any).retireAfterTurn, true);
    assert.equal(t.host.retireChat('nothing'), 0);
  });

  test('register wires acp:* IPC to the host and its events to the windows', async () => {
    const handlers: Record<string, any> = {};
    const ipcMain = { handle: (ch: string, fn: any) => (handlers[ch] = fn) };
    const calls: any[] = [];
    const host: any = new EventEmitter();
    // a chat that runs here answers its rename with nothing to wait for; one on a machine with a promise
    let sent: Promise<unknown> | null = null;
    for (const m of ['permission', 'list', 'search', 'close', 'setMode', 'setConfigOption', 'rename', 'remove'])
      host[m] = (...a: any[]) => (calls.push([m, ...a]), m === 'rename' ? sent : m);
    const broadcast: any[] = [];
    const perms: string[] = [];
    host.items = { flush: (key: string) => calls.push(['flush', key]), file: (key: string) => key };
    host.chats = new Map();
    const items = {
      history: async (key: string, _chatId: string, _cwd: string, read: () => Promise<unknown>) => {
        await read();
        calls.push(['turns', key]);
        return { page: null, ids: [], activeTurnId: null };
      },
    };
    acp.register(ipcMain, host, { broadcast: (...a: any[]) => broadcast.push(a), onPermission: (id: string) => perms.push(id), items });
    host.emit('event', { kind: 'x' });
    assert.deepEqual(broadcast, [['acp:event', { kind: 'x' }]]);
    assert.equal(handlers['acp:permission']({}, 7, undefined), 'permission');
    assert.deepEqual(perms, ['7']);
    handlers['acp:permission']({}, 'r', 'opt');
    await handlers['acp:turns']({}, 1, 'chat', '/w');
    handlers['acp:list']({});
    handlers['acp:search']({ sender: { id: 4 } }, 'term', 5, 'palette');
    handlers['acp:search']({}, 'term', 5);
    handlers['acp:setMode']({}, 3, 4);
    handlers['acp:setConfigOption']({}, 5, 6, 'v');
    assert.equal(handlers['acp:rename']({}, 7, 'n'), null);
    // a chat on a machine: the renderer is told whether the machine took the name, or why not (the name is kept here either way)
    sent = Promise.resolve({ name: 'n' });
    assert.equal(await handlers['acp:rename']({}, 7, 'n'), null);
    sent = Promise.reject(new Error('Pocket Mac is too old for this. Update it.'));
    assert.deepEqual(await handlers['acp:rename']({}, 7, 'n'), { error: 'Pocket Mac is too old for this. Update it.' });
    sent = Promise.reject('plain words');
    assert.deepEqual(await handlers['acp:rename']({}, 7, 'n'), { error: 'Plain words.' });
    // the Mac's own sentence for a machine (remoteRename.cjs) is shown as written, machine name and all, with the machine for its Update
    sent = Promise.reject(Object.assign(new Error('pocket mac is too old for this. Update it.'), { worded: true, hostId: 'box' }));
    assert.deepEqual(await handlers['acp:rename']({}, 7, 'n'), { error: 'pocket mac is too old for this. Update it.', hostId: 'box' });
    assert.deepEqual(calls.slice(0, 10), [
      ['permission', '7', null],
      ['permission', 'r', 'opt'],
      ['flush', '1'],
      ['turns', '1'],
      ['list'],
      ['search', 'term', 5, '4:palette'],
      ['search', 'term', 5, ':'],
      ['setMode', '3', '4'],
      ['setConfigOption', '5', '6', 'v'],
      ['rename', '7', 'n'],
    ]);
    assert.deepEqual(calls.slice(10), [
      ['rename', '7', 'n'],
      ['rename', '7', 'n'],
      ['rename', '7', 'n'],
      ['rename', '7', 'n'],
    ]);
    // the default permission hook does nothing
    const h2: Record<string, any> = {};
    acp.register({ handle: (ch: string, fn: any) => (h2[ch] = fn) }, host, { broadcast: () => {} });
    h2['acp:permission']({}, 'x');
  });

  test('fakeProc helper sanity: a raw line reaches the peer', () => {
    const p = fakeProc();
    const got: string[] = [];
    p.stdout.on('data', (d: string) => got.push(d));
    p.line('x\n');
    assert.deepEqual(got, ['x\n']);
  });
}
