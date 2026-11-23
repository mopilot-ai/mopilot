// What a paired phone may do with the user's machines, Mac side (electron/app/hostPhone.cjs and its wiring in electron/app/ipc/host.cjs): a chat started on a machine as a scheduled run starts one, for Claude Code, Codex and an ACP agent; Switch host with or without the changes; which machine a chat runs on; and the phones told when the machines, what their agents run with, or Host's gate change.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const org = { covers: false };
mock.module('../electron/app/ipc/hostOrgAccess.cjs', {
  namedExports: {
    registerOrgAccess: (o: any) =>
      ((org as any).opts = o) && { covers: () => org.covers, dispose: () => undefined, lend: async () => false },
  },
});
const { createHostPhone, phonePlan } = require('../electron/app/hostPhone.cjs');
const { register } = require('../electron/app/ipc/host.cjs');
const { scheduledList } = require('../electron/app/scheduledList.cjs');

function facade(o: Record<string, any> = {}) {
  const calls: any[][] = [];
  let watcher: any = null;
  let changed = 0;
  const gate = { open: true };
  const phone = createHostPhone({
    allowed: () => gate.open,
    watch: (cb: any) => (watcher = cb),
    machines: () => ({
      list: () => ({ machines: [{ id: 'm', name: 'm' }], resolved: true }),
      row: (id: string) => (id === 'm' ? { id } : undefined),
    }),
    folders: () => ({ list: async (id: string, q: any) => (calls.push(['folders', id, q]), { path: '/' }) }),
    machineChats: {
      newChatId: (h: string) => `id-${h}`,
      start: async (q: any, o: any) => (calls.push(['start', q, o]), { listed: Promise.resolve() }),
    },
    enqueue: (chatId: string, item: any, gate: Promise<unknown>) => (calls.push(['enqueue', chatId, item, gate]), { action: 'queued' }),
    setMode: (chatId: string, mode: string) => void calls.push(['mode', chatId, mode]),
    announce: (e: any) => void calls.push(['announce', e]),
    move: async (req: any) => (calls.push(['move', req]), { hostId: 'm', epoch: 2 }),
    plan: async () => ({ state: 'ready', plan: { untracked: [], unpushed: 0, files: 2 } }),
    ownership: { get: (chatId: string) => ({ hostId: chatId === 'c1' ? 'm' : 'local' }) },
    orgCovers: (h: string) => h === 'gemini',
    changed: () => void changed++,
    projects: () => [{ id: 'p1', path: '/Users/me/a' }],
    ...o,
  });
  return { phone, calls, gate, watcher: () => watcher, changed: () => changed };
}

for (const [harness, agent] of [
  ['claude', 'claude'],
  ['codex', 'codex'],
  ['acp:gemini', 'gemini'],
]) {
  test(`a phone's chat on a machine with ${harness}: made, announced to the windows, then its first message through the outbox`, async () => {
    const f = facade();
    const out = await f.phone.start({
      hostId: 'm',
      folder: '/srv',
      harness,
      projectId: 'p',
      text: 'hi',
      model: 'x',
      effort: 'high',
      permission: 'auto-review',
    });
    assert.deepEqual(out, { chatId: `id-${agent}` });
    await new Promise((r) => setImmediate(r));
    const gate = f.calls.find((c) => c[0] === 'enqueue')?.[3];
    assert.ok(gate instanceof Promise);
    assert.deepEqual(
      f.calls.map((c) => c.slice(0, 3)),
      [
        ['start', { chatId: `id-${agent}`, hostId: 'm', folder: '/srv', harness: agent, projectId: 'p' }, { background: true }],
        // the pick is the chat's mode before its first message is kept
        ['mode', `id-${agent}`, 'auto-review'],
        // the folder is read through the machine's bounded listing after the chat exists, off the reply's path
        ['folders', 'm', { path: '/srv' }],
        ['enqueue', `id-${agent}`, { text: 'hi', attachments: [], opts: { model: 'x', effort: 'high' } }],
        ['announce', { harness: 'acp', chatId: `id-${agent}`, cwd: '/srv', worktreeOf: null, hostId: 'm', projectId: 'p' }],
      ],
    );
  });
}

test('a machine that refuses makes nothing; a message that did not start is a warning, not a lost chat', async () => {
  const f = facade({
    machineChats: {
      newChatId: () => 'id',
      start: async () => {
        throw Object.assign(new Error('Sign in to Codex on m.'), { code: 'harness_not_configured' });
      },
    },
  });
  await assert.rejects(
    f.phone.start({ hostId: 'm', folder: '/', harness: 'codex', projectId: null, text: 'x', model: null, effort: null }),
    { code: 'harness_not_configured' },
  );
  assert.deepEqual(f.calls, [], 'nothing made after the machine refused');
  // a folder outside what the machine shares, or missing: move is refused before anything is made; a phone's start does not wait for the
  // read, the message is held back (its gate) and the queue shows it refused (remoteSend enqueue)
  for (const code of ['outside_roots', 'directory_missing']) {
    const bounded = facade({
      folders: () => ({
        list: async () => {
          throw Object.assign(new Error(`No: ${code}`), { code });
        },
      }),
    });
    await assert.rejects(bounded.phone.move({ chatId: 'c1', hostId: 'm', folder: '/', carry: 'none' }), { code });
    assert.equal(bounded.calls.length, 0);
    await bounded.phone.start({ hostId: 'm', folder: '/', harness: 'claude', projectId: null, text: 'x', model: null, effort: null });
    const gate = bounded.calls.find((c) => c[0] === 'enqueue')?.[3];
    await assert.rejects(gate, { code });
  }
  const failed = facade({ enqueue: () => ({ action: 'failed', error: 'Host is away' }) });
  const q = { hostId: 'm', folder: '/', harness: 'codex', projectId: null, text: 'x', model: null, effort: null };
  assert.deepEqual(await failed.phone.start(q), { chatId: 'id-codex', warning: "Your message didn't start: Host is away" });
  const off = facade({ enqueue: () => null });
  assert.deepEqual(await off.phone.start(q), { chatId: 'id-codex', warning: "Your message didn't start: Host is off" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(off.calls.at(-1), [
    'announce',
    { harness: 'acp', chatId: 'id-codex', cwd: '/', worktreeOf: null, hostId: 'm', projectId: null },
  ]);
});

test('a machine that is away: start and folders are refused as offline, move as target_offline, before any session is opened', async () => {
  const away = { list: () => ({ machines: [{ id: 'm', name: 'box', status: 'offline' }], resolved: true }), row: () => ({ id: 'm' }) };
  const f = facade({ machines: () => away });
  const q = { hostId: 'm', folder: '/srv', harness: 'claude', projectId: null, text: 'x', model: null, effort: null };
  await assert.rejects(f.phone.start(q), { code: 'offline', message: "box isn't reachable. Check it's online, then try again." });
  await assert.rejects(f.phone.folders('m'), { code: 'offline' });
  await assert.rejects(f.phone.move({ chatId: 'c1', hostId: 'm', folder: '/srv', carry: 'none' }), {
    code: 'target_offline',
    message: "box isn't reachable. Check it's online, then try again.",
  });
  assert.equal(f.calls.length, 0, 'no session was opened, nothing made, nothing moved');
  // a machine that is not in the list is said so, not as away
  await assert.rejects(f.phone.start({ ...q, hostId: 'x' }), { code: 'unknown_machine' });
  await assert.rejects(f.phone.folders('x'), { code: 'unknown_machine' });
});

test('a transport or ssh failure reading a folder is said as a short offline refusal, never its own text', async () => {
  const f = facade({
    machines: () => ({
      list: () => ({ machines: [{ id: 'm', name: 'box', status: 'online' }], resolved: true }),
      row: () => ({ id: 'm' }),
    }),
    folders: () => ({
      list: async () => {
        throw new Error('connect ENOENT /var/folders/xx/host-tunnels/ssh-box.sock (ssh dev@10.0.0.7: connection refused)');
      },
    }),
  });
  for (const run of [() => f.phone.folders('m', '/srv'), () => f.phone.move({ chatId: 'c1', hostId: 'm', folder: '/srv', carry: 'none' })])
    await assert.rejects(run(), (e: any) => {
      assert.match(e.code, /^(offline|target_offline)$/);
      assert.equal(e.message, "box isn't reachable. Check it's online, then try again.");
      assert.doesNotMatch(e.message, /ENOENT|sock|10\.0\.0\.7/);
      return true;
    });
  assert.equal(f.calls.length, 0, 'nothing was made or moved');
  // a phone's start does not wait for the read: the same short refusal gates the first message
  await f.phone.start({ hostId: 'm', folder: '/srv', harness: 'codex', projectId: null, text: 'x', model: null, effort: null });
  await assert.rejects(f.calls.find((c) => c[0] === 'enqueue')?.[3], (e: any) => {
    assert.equal(e.code, 'offline');
    assert.doesNotMatch(e.message, /ENOENT|sock|10\.0\.0\.7/);
    return true;
  });
});

test('Switch host from a phone: the changes only when the dialog’s plan says the folder takes them and nothing needs a confirmation', async () => {
  const q = { chatId: 'c1', hostId: 'm', folder: '/srv', carry: 'code' };
  for (const [facts, code] of [
    [null, 'unsupported'],
    [{ state: 'no_source_folder', plan: null }, 'no_source_folder'],
    [{ state: 'other_branch', plan: { files: 1 } }, 'carry_other_branch'],
    [{ state: 'other_repository', plan: { files: 1 } }, 'carry_mismatch'],
    [{ state: 'no_repository', plan: { files: 1 } }, 'carry_no_repository'],
    [{ state: 'unverified', plan: { files: 1 } }, 'carry_unconfirmed'],
    [{ state: 'ready', plan: { untracked: ['new.txt'], unpushed: 0, files: 2 } }, 'carry_unconfirmed'],
    [{ state: 'ready', plan: { untracked: [], unpushed: 1, files: 2 } }, 'carry_unconfirmed'],
    [{ state: 'ready', plan: { files: 0 } }, 'nothing_to_carry'],
  ] as const) {
    const f = facade({ plan: async () => facts });
    await assert.rejects(f.phone.move(q), { code }, String(code));
    assert.ok(!f.calls.some((c) => c[0] === 'move'), 'nothing moves when the changes can not go');
  }
  // nothing to carry (no repository, nothing changed): it moves without changes, as the Mac's dialog does
  const clean = facade({ plan: async () => ({ state: 'ready', plan: null }) });
  await clean.phone.move(q);
  assert.equal(clean.calls.at(-1)?.[1].carry, null);
  // without the changes the plan is not read at all
  let planned = 0;
  const f = facade({ plan: async () => (planned++, null) });
  await f.phone.move({ ...q, carry: 'none' });
  assert.equal(planned, 0);
});

test('back to this Mac by a project’s id: the Mac resolves its folder; an unknown id and a chat already here are refused; the folder form still works', async () => {
  const f = facade();
  // c1 runs on machine m; the id names a saved project, never a path the phone sent
  await f.phone.move({ chatId: 'c1', hostId: 'local', projectId: 'p1', carry: 'none' });
  assert.deepEqual(f.calls.at(-1)?.[1], { chatId: 'c1', targetHostId: 'local', cwd: '/Users/me/a', lostHostConfirmed: false, carry: null });
  // the folder form is unchanged
  await f.phone.move({ chatId: 'c1', hostId: 'local', folder: '/Users/me/a', carry: 'none' });
  assert.equal(f.calls.at(-1)?.[1].cwd, '/Users/me/a');
  const moved = f.calls.length;
  // an id that is not a saved project is refused with its own code, and nothing moves
  await assert.rejects(f.phone.move({ chatId: 'c1', hostId: 'local', projectId: 'nope', carry: 'none' }), {
    code: 'unknown_project',
    message: "That project isn't in MoPilot.",
  });
  // c2 already runs on this Mac: nothing to move, with an id or a folder, before any project is looked up
  for (const where of [{ projectId: 'p1' }, { projectId: 'nope' }, { folder: '/Users/me/a' }])
    await assert.rejects(f.phone.move({ chatId: 'c2', hostId: 'local', carry: 'none', ...where }), {
      code: 'same_host',
      message: 'This chat already runs there.',
    });
  assert.equal(f.calls.length, moved, 'nothing moved');
  // the changes still go through the plan on the way back
  let planned = 0;
  const withPlan = facade({ plan: async () => (planned++, { state: 'ready', plan: null }) });
  await withPlan.phone.move({ chatId: 'c1', hostId: 'local', projectId: 'p1', carry: 'code' });
  assert.equal(planned, 1);
});

test('Switch host from a phone: the changes only when asked, never new files or unpushed commits; the rest of the facade', async () => {
  const f = facade();
  await f.phone.move({ chatId: 'c1', hostId: 'local', folder: '/Users/me/a', carry: 'code' });
  await f.phone.move({ chatId: 'c1', hostId: 'm', folder: '/srv', carry: 'none' });
  // back to this Mac only into a saved project's folder
  await assert.rejects(f.phone.move({ chatId: 'c1', hostId: 'local', folder: '/', carry: 'none' }), { code: 'outside_roots' });
  // the phone is checked again after the reads, before the move
  let checks = 0;
  await assert.rejects(
    f.phone.move({
      chatId: 'c1',
      hostId: 'm',
      folder: '/srv',
      carry: 'code',
      check: () => {
        checks++;
        throw new Error('This device is no longer paired.');
      },
    }),
    /no longer paired/,
  );
  assert.equal(checks, 1);
  f.calls.splice(0, f.calls.length, ...f.calls.filter((c) => c[0] === 'move'));
  assert.deepEqual(
    f.calls.map((c) => c[1]),
    [
      {
        chatId: 'c1',
        targetHostId: 'local',
        cwd: '/Users/me/a',
        lostHostConfirmed: false,
        carry: { confirmed: true, untracked: [], unpushed: 0 },
      },
      { chatId: 'c1', targetHostId: 'm', cwd: '/srv', lostHostConfirmed: false, carry: null },
    ],
  );
  assert.deepEqual(f.phone.rows(), [{ id: 'm', name: 'm' }]);
  assert.deepEqual([f.phone.record('m'), f.phone.record('x')], [{ id: 'm' }, null]);
  assert.deepEqual([f.phone.orgCovers('gemini'), f.phone.orgCovers('codex')], [true, false]);
  f.calls.length = 0;
  await f.phone.folders('m');
  await f.phone.folders('m', '/srv');
  assert.deepEqual(f.calls, [
    ['folders', 'm', {}],
    ['folders', 'm', { path: '/srv' }],
  ]);
  assert.deepEqual([f.phone.hostOf('c1'), f.phone.hostOf('c2')], ['m', 'local']);
  f.gate.open = false;
  assert.equal(f.phone.hostOf('c1'), 'local', 'without Host every chat is this Mac’s');
  assert.equal(f.phone.allowed(), false);
  f.watcher()(true);
  assert.equal(f.changed(), 1, 'a gate change tells the phones');
});

test('the scheduled list a phone reads: active tasks with a time, soonest first, each with its machine fields', async () => {
  const tasks = [
    { id: 'b', name: 'B', status: 'ACTIVE', rrule: 'FREQ=DAILY;BYHOUR=5;BYMINUTE=0' },
    { id: 'a', status: 'ACTIVE', rrule: 'FREQ=DAILY;BYHOUR=3;BYMINUTE=0', host_id: 'm' },
    { id: 'p', name: 'Paused', status: 'PAUSED', rrule: 'FREQ=DAILY' },
    { id: 'n', name: 'None', status: 'ACTIVE' },
  ];
  const now = () => new Date(2026, 0, 1, 0, 0);
  const list = await scheduledList({ list: async () => ({ tasks }) }, (t: any) => ({ hostId: t.host_id ?? null }), now);
  assert.deepEqual(
    list.map((t: any) => [t.id, t.name, t.hostId]),
    [
      ['a', 'a', 'm'],
      ['b', 'B', null],
    ],
  );
  const bare = await scheduledList({
    list: async () => ({ tasks: [{ id: 'x', status: 'ACTIVE', rrule: 'FREQ=YEARLY;COUNT=0' }, ...tasks] }),
  });
  assert.equal(bare.at(-1).next, bare.at(-1).id === 'x' ? null : bare.at(-1).next);
  assert.ok(!('hostId' in bare[0]), 'no machine fields before the scheduler is wired');
});

let remoteOn = true;
let dropAfterBegin = false;

test('Host IPC: the phone facade over the same services; Switch host refused without the gate; the phones told of every change', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-phone-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let told = 0;
  const gate = { open: true };
  const sent: any[] = [];
  let given: any = null;
  const live: any = {
    chromePanel: { service: { onMachinesChanged: () => void told++ } },
    hostContinue: async (r: any) => (sent.push(['continue', r]), { hostId: 'm', epoch: 2 }),
    announceRunChat: (e: any) => sent.push(['announce', e.chatId]),
    controller: { state: { patch: (chatId: string, p: any) => sent.push(['mode', chatId, p.permission]) } },
  };
  const handlers = new Map<string, any>();
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { live, app: { getPath: () => dir, once: () => undefined }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    {
      create: (o: any) => (
        (given = o),
        {
          list: () => ({ machines: [{ id: 'm' }], resolved: true }),
          row: () => ({ id: 'm', name: 'box', harnesses: [{ id: 'claude', detected: true, signedIn: true }] }),
          dispose: () => undefined,
        }
      ),
      createFolders: () => ({ bind: () => undefined, list: async () => ({ path: '/srv', roots: [], entries: [] }) }),
      makeRemoteSend: () => () =>
        remoteOn
          ? {
              // a channel that goes down between the chat's start and its first message (remoteOn turned off by the test)
              begin: () => void (remoteOn = !dropAfterBegin),
              enqueue: (chatId: string) => (sent.push(['send', chatId]), { action: 'queued' }),
              moving: () => false,
              holdMove: () => undefined,
              endMove: async () => undefined,
              resume: async () => undefined,
              dispose: () => undefined,
            }
          : null,
      allowed: () => gate.open,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (v: string) => Buffer.from(v),
        decryptString: (b: Buffer) => b.toString(),
      },
    },
  );
  const phone = live.hostPhone;
  assert.equal(phone.allowed(), true);
  assert.deepEqual(phone.rows(), [{ id: 'm' }]);
  assert.equal(phone.record('m').name, 'box');
  assert.equal(phone.orgCovers('claude'), false);
  org.covers = true;
  assert.equal(phone.orgCovers('claude'), true);
  assert.deepEqual(await phone.folders('m'), { path: '/srv', roots: [], entries: [] });
  const started = await phone.start({
    hostId: 'm',
    folder: '/srv',
    harness: 'claude',
    projectId: null,
    text: 'hi',
    model: null,
    effort: null,
  });
  assert.match(started.chatId, /^acp:host-claude:/);
  await new Promise((r) => setImmediate(r));
  // the first message is kept at once; the windows are told once the chat is listed
  assert.deepEqual(
    sent.map((s) => s[0]),
    ['send', 'announce'],
  );
  assert.equal(phone.hostOf('nobody'), 'local');
  // the remote channel goes away between the start and the first message: a warning on the chat that was made
  dropAfterBegin = true;
  const away = await phone.start({
    hostId: 'm',
    folder: '/srv',
    harness: 'claude',
    projectId: null,
    text: 'hi',
    model: null,
    effort: null,
  });
  assert.match(away.warning, /Host is off/);
  dropAfterBegin = false;
  remoteOn = true;
  assert.deepEqual(await phone.move({ chatId: 'c1', hostId: 'm', folder: '/srv', carry: 'none' }), { hostId: 'm', epoch: 2 });
  assert.deepEqual(sent.at(-1), ['continue', { chatId: 'c1', targetHostId: 'm', cwd: '/srv', lostHostConfirmed: false, carry: null }]);
  // the changes go only with the dialog's plan, which this app reads only with a switch runner
  await assert.rejects(phone.move({ chatId: 'c1', hostId: 'm', folder: '/srv', carry: 'code' }), { code: 'unsupported' });
  // nothing is owned elsewhere in this userData, so a chat is already on this Mac
  await assert.rejects(phone.move({ chatId: 'c1', hostId: 'local', folder: '/srv', carry: 'none' }), { code: 'same_host' });
  gate.open = false;
  await assert.rejects(phone.move({ chatId: 'c1', hostId: 'm', folder: '/srv', carry: 'none' }), { code: 'not_allowed' });
  gate.open = true;
  // the machines changing, a key changing, and the organization's access changing each tell the phones
  given.onChange({ machines: [], resolved: true });
  // a remove that finds no key changes nothing and tells no one
  await handlers.get('host:removeApiKey')({}, 'anthropic');
  assert.equal(told, 1);
  await handlers.get('host:setApiKey')({}, 'anthropic', 'sk-ant-dummy-0000-test-key-abcd');
  (org as any).opts.broadcast('host:orgAccess', {});
  assert.equal(told, 3);
  // without a side panel yet nothing is told and nothing throws
  delete live.chromePanel;
  assert.doesNotThrow(() => given.onChange({ machines: [], resolved: true }));
  // a window's own Switch host still goes through the same continue
  assert.deepEqual(await handlers.get('host:continue')({}, { chatId: 'c2', targetHostId: 'm', cwd: '/x' }), {
    value: { hostId: 'm', epoch: 2 },
  });
});

test('phonePlan: no switch runner stays null (unsupported); a runner with no source folder is its own state (#3765)', () => {
  const plan = { state: 'ready', plan: { files: 1 } };
  assert.equal(phonePlan(plan, true), plan);
  assert.equal(phonePlan(null, false), null);
  assert.deepEqual(phonePlan(null, true), {
    state: 'no_source_folder',
    repository: null,
    branch: null,
    dirty: 0,
    plan: null,
  });
});

test('back to this Mac: a saved project is matched by its folder, not its spelling, and the move uses the project’s own path (#3765)', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phone-proj-')));
  const real = path.join(root, 'Proj');
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(root, 'link'));
  const f = facade({ projects: () => [{ path: real }] });
  for (const named of [real + path.sep, path.join(root, 'link'), path.join(root, 'Proj', '..', 'Proj')]) {
    await f.phone.move({ chatId: 'c1', hostId: 'local', folder: named, carry: 'none' });
    assert.equal(f.calls.filter((c) => c[0] === 'move').at(-1)![1].cwd, real, named);
  }
  // a folder that is gone still compares by its spelling, and another folder is refused
  const gone = path.join(root, 'gone');
  const g = facade({ projects: () => [{ path: gone }] });
  await g.phone.move({ chatId: 'c1', hostId: 'local', folder: gone + path.sep, carry: 'none' });
  await assert.rejects(g.phone.move({ chatId: 'c1', hostId: 'local', folder: real, carry: 'none' }), { code: 'outside_roots' });
});

test('back to this Mac: a folder that cannot be read is refused as outside the projects, and case folds only when no exact case matches (#3765)', async () => {
  const f = facade({ projects: () => [{ path: '/Users/me/a' }] });
  await assert.rejects(f.phone.move({ chatId: 'c1', hostId: 'local', folder: '/Users/me/a\0', carry: 'none' }), { code: 'outside_roots' });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phone-case-')));
  fs.mkdirSync(path.join(root, 'App'));
  const named = (foldCase: boolean, saved: string[], folder: string) =>
    facade({ foldCase, projects: () => saved.map((name) => ({ path: path.join(root, name) })) }).phone.move({
      chatId: 'c1',
      hostId: 'local',
      folder: path.join(root, folder),
      carry: 'none',
    });
  // exact spelling wins; a spelling differing only in case matches only where volumes ignore case
  const both = facade({ foldCase: true, projects: () => [{ path: path.join(root, 'APP') }, { path: path.join(root, 'App') }] });
  await both.phone.move({ chatId: 'c1', hostId: 'local', folder: path.join(root, 'App'), carry: 'none' });
  assert.equal(both.calls.filter((c) => c[0] === 'move').at(-1)![1].cwd, path.join(root, 'App'));
  if (!fs.existsSync(path.join(root, 'APP'))) {
    await assert.rejects(named(false, ['App'], 'APP'), { code: 'outside_roots' });
    await named(true, ['App'], 'APP');
  }
});

test('imageHostFor: the gated machine connection, null when the gate is closed or the registry cannot hand one out', () => {
  const connection = { id: 'conn' };
  const withHostFor = facade({
    machines: () => ({
      list: () => ({ machines: [] }),
      row: () => undefined,
      hostFor: (id: string) => (id === 'm' ? connection : undefined),
    }),
  });
  assert.equal(withHostFor.phone.imageHostFor('m'), connection);
  assert.equal(withHostFor.phone.imageHostFor('other'), null, 'an unknown machine is null, not undefined');
  withHostFor.gate.open = false;
  assert.equal(withHostFor.phone.imageHostFor('m'), null, 'a closed gate hands out nothing');
  assert.equal(facade().phone.imageHostFor('m'), null, 'a registry without hostFor hands out nothing');
});

test('a start carries the phone-chosen native message id on the queued item only when there is one', async () => {
  const q = { hostId: 'm', folder: '/', harness: 'claude', projectId: null, text: 'x', model: null, effort: null };
  const withId = facade();
  await withId.phone.start({ ...q, nativeMessageId: 'native-1' });
  assert.equal(withId.calls.find((c) => c[0] === 'enqueue')?.[2].id, 'native-1');
  const without = facade();
  await without.phone.start(q);
  assert.equal(Object.hasOwn(without.calls.find((c) => c[0] === 'enqueue')?.[2], 'id'), false);
});
