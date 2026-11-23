// electron/app/sessionHost.cjs and sessionManagement.cjs: what the session-management tools ask of main (a chat's facts,
// transcript, usage, export, title, archive, deletion and start targets) goes through each chat's own harness adapter by
// chat id, the same on Codex, Claude Code and ACP, with no window needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { family, registryFor, textOf } from './support/sessionManagementFakes.ts';

const require = createRequire(import.meta.url);
const { createSessionHost } = require('../electron/app/sessionHost.cjs');
const { registerSessionManagement } = require('../electron/app/sessionManagement.cjs');

const KINDS: Record<string, string> = { cx: 'codex', cl: 'claude', ap: 'acp:kimi' };

function setup(o: { downloads?: string; context?: any; instances?: any; history?: any } = {}) {
  const fam = family();
  const calls: any[] = [];
  const records = new Map<string, any>(
    Object.keys(KINDS).map((id) => [
      id,
      { segments: [{ kind: KINDS[id] }], meta: { notes: [], archived: id === 'cx' ? 5 : null, pinned: id === 'cl' }, updatedAt: 1000 },
    ]),
  );
  const live: any = {
    controller: {
      ref: (id: string) => ({ kind: KINDS[id], id: `native-${id}`, key: `key-${id}` }),
      state: { get: () => ({ activeTurn: { id: 'ct-1' }, acp: { configOptions: [] } }) },
    },
    chats: {
      records: { get: (id: string) => records.get(id) },
      get: (id: string) => ({ chat: id }),
      patchMeta: (id: string, patch: any) => {
        if (id === 'ap' && patch.notes && live.failNotes) return false;
        if (live.failMeta) return false;
        Object.assign(records.get(id).meta, patch);
        calls.push(['meta', id, patch]);
        return true;
      },
    },
    codex: {
      chatName: (id: string) => (id === 'cx' ? 'Codex name' : null),
      codexThread: (id: string) => (live.noThread ? null : `thread-${id}`),
      threadRename: async (...a: any[]) => calls.push(['codex rename', ...a]),
      threadUnarchive: async (...a: any[]) => {
        calls.push(['codex unarchive', ...a]);
        if (live.codexFails) throw new Error('not archived there');
      },
    },
    claudeTurns: {
      api: { rename: async (...a: any[]) => calls.push(['claude rename', ...a]) },
      settings: () => ({ model: 'opus', effort: 'high', permission: 'default', fast: false }),
    },
    acpHost: { rename: async (...a: any[]) => calls.push(['acp rename', ...a]) },
    chatDeletion: { delete: async (id: string) => calls.push(['delete', id]) },
    peerRuntime: {
      readHistory: async (id: string) =>
        o.history !== undefined
          ? o.history
          : {
              turns: [
                {
                  id: 't1',
                  items: [
                    { type: 'userMessage', content: [{ type: 'text', text: 'hi there' }] },
                    { type: 'agentMessage', text: 'hello' },
                  ],
                },
              ],
              earlierContentOmitted: id === 'ap',
            },
    },
    identity: { instances: (f: string) => (o.instances ? o.instances(f) : []) },
  };
  let clock = 1_700_000_000_000;
  const dir = o.downloads ?? fs.mkdtempSync(path.join(os.tmpdir(), 'session-host-'));
  const changed: string[] = [];
  const host = createSessionHost({
    live,
    orchestrator: fam.orchestrator,
    prefs: () => ({ model: 'gpt-5', permission: 'default' }),
    projectOf: async (id: string) => (id === 'ap' ? null : `/w/${id}`),
    worktreeInfo: (dir2: string) => (dir2 === '/w/cl' ? { branch: 'feat/x' } : null),
    projects: () => [{ id: 'p1', name: 'Proj', path: '/w/proj' }],
    downloads: () => dir,
    changed: (id: string) => changed.push(id),
    context: () => o.context ?? null,
    now: () => (clock += 1000),
  });
  return { host, live, calls, records, dir, changed, fam, clock: () => clock };
}

test('describe reports a chat’s facts on each harness, with the branch of a worktree and no fast mode where there is none', async (t) => {
  const s = setup();
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  assert.deepEqual(await s.host.describe('cx'), {
    title: 'Codex name',
    harness: 'codex',
    cwd: '/w/cx',
    branch: null,
    archivedAt: 5,
    pinned: false,
    lastActivityAt: 1000,
    model: 'gpt-5',
    effort: null,
    permission: 'default',
    fast: { state: 'off' },
    pendingSwitch: null,
  });
  const cl = await s.host.describe('cl');
  assert.deepEqual(
    [cl.harness, cl.branch, cl.pinned, cl.archivedAt, cl.model, cl.fast],
    ['claude', 'feat/x', true, null, 'opus', { state: 'off' }],
  );
  const ap = await s.host.describe('ap');
  assert.deepEqual([ap.harness, ap.cwd, ap.branch, ap.fast, ap.title], ['acp:kimi', null, null, undefined, null]);
  assert.equal(await s.host.describe('nobody'), null);
  s.live.claudeTurns.settings = () => ({ model: 'opus', fast: true });
  assert.deepEqual((await s.host.describe('cl')).fast, { state: 'on' });
  // a linked session is titled by its link; a chat main cannot place on a harness still reports its last segment
  s.fam.children.alpha.title = 'Linked title';
  s.records.set('alpha', { segments: [{ kind: 'codex' }, { kind: 'claude' }], meta: {}, updatedAt: 2 });
  s.live.controller.ref = () => {
    throw new Error('unknown');
  };
  const odd = await s.host.describe('alpha');
  assert.deepEqual([odd.title, odd.harness, odd.model, odd.permission, odd.fast], ['Linked title', 'claude', null, null, undefined]);
});

test('history returns the chat’s turns and whether earlier content was cut, or nothing for a chat it cannot read', async () => {
  const s = setup();
  assert.deepEqual((await s.host.history('cx')).omitted, false);
  assert.deepEqual((await s.host.history('ap')).omitted, true);
  assert.equal(await s.host.history('nobody'), null);
  assert.equal(await setup({ history: null }).host.history('cx'), null);
  const bare = setup();
  bare.live.peerRuntime = {};
  assert.equal(await bare.host.history('cx'), null);
});

test('usage reads a harness’s logins and the chat’s last context measurement', async () => {
  const snapshot = {
    used: 5000,
    window: 20000,
    model: 'opus',
    at: 1_700_000_000_000,
    autoCompact: { enabled: true, threshold: 16000 },
    categories: [
      { label: 'Messages', tokens: 3000, kind: 'used' },
      { label: 'Free space', tokens: 15000, kind: 'free' },
      ...['A', 'B', 'C', 'D', 'E'].map((label, i) => ({ label, tokens: 100 - i, kind: 'used' })),
    ],
  };
  const asked: string[] = [];
  const instances = (f: string) =>
    f === 'codex'
      ? [
          { account: 'a1', label: 'me@x', billing: 'subscription', active: true, limited: true, limitedUntil: 1_700_003_600_000 },
          { account: 'a2', billing: 'harness', active: false, limited: false },
          { account: 'k', billing: 'apiKey' },
        ]
      : f === 'claude'
        ? [{ account: 'key', billing: 'apiKey' }]
        : [];
  const s = setup({
    instances,
    context: {
      service: { get: (owner: string) => (asked.push(owner), owner === JSON.stringify(['cx', 'codex', 'key-cx']) ? snapshot : null) },
    },
  });
  const cx = await s.host.usage('cx');
  assert.deepEqual(cx.plan, {
    status: 'ok',
    logins: [
      { login: 'me@x', active: true, outOfUsage: true, resetsAt: '2023-11-14T23:13:20.000Z' },
      { login: 'a2', active: false, outOfUsage: false },
    ],
  });
  assert.deepEqual(cx.context, {
    status: 'ok',
    model: 'opus',
    tokensUsed: 5000,
    windowTokens: 20000,
    percentUsed: 25,
    autoCompactAtTokens: 16000,
    measuredAt: '2023-11-14T22:13:20.000Z',
    largestCategories: [
      { name: 'Messages', tokens: 3000 },
      { name: 'A', tokens: 100 },
      { name: 'B', tokens: 99 },
      { name: 'C', tokens: 98 },
      { name: 'D', tokens: 97 },
    ],
  });
  const cl = await s.host.usage('cl');
  assert.equal(cl.plan.status, 'not_applicable');
  assert.equal(cl.context.status, 'unavailable');
  assert.equal((await s.host.usage('ap')).plan.status, 'unavailable');
  assert.equal(await s.host.usage('nobody'), null);
  assert.deepEqual(asked[0], JSON.stringify(['cx', 'codex', 'key-cx']));
  // a measurement with no window or compaction says what it has; none at all, or no service yet, is unavailable
  const thin = setup({
    context: { service: { get: () => ({ used: 10, at: 0, categories: undefined, autoCompact: { enabled: false } }) } },
  });
  assert.deepEqual((await thin.host.usage('cl')).context, {
    status: 'ok',
    model: undefined,
    tokensUsed: 10,
    windowTokens: undefined,
    percentUsed: undefined,
    autoCompactAtTokens: undefined,
    measuredAt: '1970-01-01T00:00:00.000Z',
    largestCategories: [],
  });
  const empty = setup({ context: { service: { get: () => ({ used: null }) } } });
  assert.equal((await empty.host.usage('cl')).context.status, 'unavailable');
  const noIdentity = setup();
  noIdentity.live.identity = undefined;
  assert.equal((await noIdentity.host.usage('cx')).plan.status, 'unavailable');
  const unknownKind = setup();
  unknownKind.live.controller.ref = () => ({ kind: 'mystery', key: 'k' });
  assert.equal((await unknownKind.host.usage('cx')).plan.status, 'unavailable');
});

test('setTitle names the chat on its own harness and keeps the link’s title in step', async () => {
  const s = setup();
  await s.host.setTitle('cx', 'New');
  await s.host.setTitle('cl', 'New');
  await s.host.setTitle('ap', 'New');
  assert.deepEqual(s.calls, [
    ['codex rename', 'thread-cx', 'New'],
    ['claude rename', 'native-cl', 'New'],
    ['acp rename', 'key-ap', 'New', false],
  ]);
  // a chat on a machine whose Host did not take the name (the phone's rename comes this way): the ACP host's answer reaches the caller, in the machine's words
  s.live.acpHost.rename = async () =>
    Promise.reject(new Error("Can't reach the machine, so it did not get the new name. The chat keeps it here."));
  await assert.rejects(s.host.setTitle('ap', 'x'), /Can't reach the machine/);
  s.records.set('alpha', { segments: [{ kind: 'codex' }], meta: {}, updatedAt: 1 });
  s.live.controller.ref = () => ({ kind: 'codex', id: 'n', key: 'k' });
  await s.host.setTitle('alpha', 'Linked new');
  assert.equal(s.fam.children.alpha.title, 'Linked new');
  await assert.rejects(s.host.setTitle('nobody', 'x'), /no longer available/);
  s.live.noThread = true;
  await assert.rejects(s.host.setTitle('alpha', 'x'), /Session alpha is no longer available/);
});

test('unarchive restores the chat, tells the windows, and keeps Codex’s own archive in step without depending on it', async () => {
  const s = setup();
  await s.host.unarchive('cx');
  assert.deepEqual(s.calls, [
    ['codex unarchive', 'thread-cx'],
    ['meta', 'cx', { archived: null }],
  ]);
  assert.deepEqual(s.changed, ['cx']);
  assert.ok(s.fam.calls.some((c: any[]) => c[0] === 'pump'));
  s.calls.length = 0;
  s.live.chats.records.get('cl').meta.archived = 5;
  await s.host.unarchive('cl');
  assert.deepEqual(s.calls, [['meta', 'cl', { archived: null }]], 'a harness with no archive of its own');
  s.live.codexFails = true;
  s.live.chats.records.get('cx').meta.archived = 5;
  await s.host.unarchive('cx');
  assert.deepEqual(s.calls.at(-1), ['meta', 'cx', { archived: null }], 'a chat Codex never archived is restored all the same');
  assert.ok(
    s.fam.calls.some((c: any[]) => c[0] === 'noted' && c[2] === 'not archived there'),
    'the failure is noted, not lost',
  );
  s.live.noThread = true;
  await s.host.unarchive('cx');
  s.live.failMeta = true;
  s.live.chats.records.get('cl').meta.archived = 5;
  await assert.rejects(s.host.unarchive('cl'), /could not be restored/);
  await assert.rejects(s.host.unarchive('nobody'), /no longer available/);
});

test('unarchive of a chat that is not archived succeeds, a restore that cannot be saved still fails', async () => {
  const s = setup();
  s.live.chats.records.get('cl').meta.archived = null;
  s.calls.length = 0;
  await s.host.unarchive('cl');
  assert.deepEqual(s.calls, [], 'nothing to write');
  assert.deepEqual(s.changed, [], 'no window is told of a change that did not happen');
});

test('remove goes through the app’s own deletion', async () => {
  const s = setup();
  await s.host.remove('cl');
  assert.deepEqual(s.calls, [['delete', 'cl']]);
  s.live.chatDeletion = undefined;
  await assert.rejects(s.host.remove('cl'), /Deleting chats is not available/);
});

test('exportTranscript writes a Markdown file to Downloads without overwriting an earlier export', async (t) => {
  const s = setup();
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  const first = await s.host.exportTranscript('ap');
  assert.equal(path.dirname(first.file), s.dir);
  assert.match(path.basename(first.file), /^session-native-ap|^session-key-ap|^session-ap/);
  const text = fs.readFileSync(first.file, 'utf8');
  assert.equal(first.bytes, Buffer.byteLength(text));
  assert.match(
    text,
    /^# Session\n\n- Session: ap\n- Harness: acp:kimi\n- Folder: unknown\n- Exported: 2023-11-14T22:13:2\d\.000Z\n- Earlier history was omitted by the harness\.\n\nUser: hi there\n\nAssistant: hello\n/,
  );
  assert.equal((fs.statSync(first.file).mode & 0o777).toString(8), '600');
  const second = await s.host.exportTranscript('ap');
  assert.notEqual(second.file, first.file);
  assert.match(path.basename(second.file), /-1\.md$/);
  const titled = await s.host.exportTranscript('cx');
  assert.match(path.basename(titled.file), /^codex-name-/);
  assert.match(fs.readFileSync(titled.file, 'utf8'), /^# Codex name\n\n- Session: cx\n- Harness: codex\n- Folder: \/w\/cx\n/);
  assert.doesNotMatch(fs.readFileSync(titled.file, 'utf8'), /Earlier history/);
  assert.equal(await s.host.exportTranscript('nobody'), null);
  await assert.rejects(
    setup({ downloads: path.join(s.dir, 'missing', 'dir') }).host.exportTranscript('cx'),
    /transcript could not be written/,
  );
  // a chat with no usable name or id slug still gets a file name
  s.records.set('###', { segments: [{ kind: 'codex' }], meta: {}, updatedAt: 1 });
  s.live.codex.chatName = () => '###';
  s.live.controller.ref = () => ({ kind: 'codex', id: 'n', key: 'k' });
  assert.match(path.basename((await s.host.exportTranscript('###')).file), /^session-chat\.md$/);
});

test('noteChapter saves a note the windows show among the turns, and tells them', async () => {
  const s = setup();
  s.host.noteChapter('cl', { title: 'Auth fix', summary: '' });
  s.host.noteChapter('cl', { title: 'Verify', summary: 'run the suite' });
  const notes = s.records.get('cl').meta.notes;
  assert.deepEqual(
    notes.map((n: any) => [n.kind, n.text, n.turnId, n.turn]),
    [
      ['chapter', 'Chapter: Auth fix', 'ct-1', Number.MAX_SAFE_INTEGER],
      ['chapter', 'Chapter: Verify - run the suite', 'ct-1', Number.MAX_SAFE_INTEGER],
    ],
  );
  assert.notEqual(notes[0].id, notes[1].id);
  assert.deepEqual(s.changed, ['cl', 'cl']);
  s.live.controller.state.get = () => ({});
  s.records.get('cx').meta.notes = undefined;
  s.host.noteChapter('cx', { title: 'T', summary: '' });
  assert.equal(s.records.get('cx').meta.notes[0].turnId, null);
  assert.throws(() => s.host.noteChapter('nobody', { title: 'T', summary: '' }), /no longer available/);
  s.live.failMeta = true;
  assert.throws(() => s.host.noteChapter('cl', { title: 'T', summary: '' }), /chapter could not be saved/);
});

test('startTargets lists the harnesses that can take a chat now, this chat’s folder and the saved projects', async () => {
  const s = setup();
  const targets = await s.host.startTargets('cl');
  assert.deepEqual(targets.harnesses, [
    { harness: 'codex', thisChat: false },
    { harness: 'claude', thisChat: true },
  ]);
  assert.deepEqual(targets.thisChat, { harness: 'claude', folder: '/w/cl', branch: 'feat/x' });
  assert.deepEqual(targets.projects, [{ name: 'Proj', folder: '/w/proj' }]);
  const noFolder = await s.host.startTargets('ap');
  assert.deepEqual(noFolder.thisChat, { harness: 'acp:kimi', folder: null, branch: null });
  s.fam.orchestrator.o.kinds = undefined;
  assert.deepEqual((await s.host.startTargets('cl')).harnesses, []);
});

test('registerSessionManagement puts the tools on the registry over a host with the app’s projects, Downloads and window notice', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-mgmt-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(home, 'projects.json'),
    JSON.stringify({ schemaVersion: 1, projects: [{ id: 'p1', name: 'Proj', path: '/w/proj' }] }),
  );
  const s = setup();
  const { r, call } = registryFor();
  const broadcasts: any[] = [];
  const mainLive: any = {
    capabilities: r,
    chats: s.live.chats,
    controller: s.live.controller,
    codex: s.live.codex,
    claudeTurns: s.live.claudeTurns,
    acpHost: s.live.acpHost,
    peerRuntime: s.live.peerRuntime,
    chatDeletion: s.live.chatDeletion,
    identity: s.live.identity,
  };
  const dispose = registerSessionManagement(mainLive, {
    orchestrator: s.fam.orchestrator,
    owner: (ctx: any) => ctx.chatId,
    prefs: () => ({}),
    projectOf: async () => '/w/cx',
    worktreeInfo: () => null,
    userData: home,
    broadcastAll: (channel: string, payload: unknown) => broadcasts.push([channel, payload]),
  });
  assert.equal(r.list().length, 18);
  // a paired phone renames and restores chats through the same host (app/phoneChatOps.cjs)
  assert.equal(typeof mainLive.sessionHost.setTitle, 'function');
  const targets = JSON.parse(textOf(await call('cx', 'list_start_targets')));
  assert.deepEqual(targets.projects, [{ name: 'Proj', folder: '/w/proj' }]);
  await call('cl', 'mark_chapter', { title: 'Phase' });
  assert.deepEqual(broadcasts, [['chats:changed', { id: 'cl', chat: { chat: 'cl' } }]]);
  // Downloads is the user's, under their home folder
  const saved = process.env.HOME;
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, 'Downloads'));
  try {
    s.fam.children.alpha.title = 'Alpha';
    s.records.set('alpha', { segments: [{ kind: 'codex' }], meta: {}, updatedAt: 1 });
    s.live.controller.ref = () => ({ kind: 'codex', id: 'n', key: 'k' });
    const out = textOf(await call('cx', 'export_transcript', { session_id: 'self' }));
    assert.match(out, new RegExp(`transcript to ${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/Downloads/`));
  } finally {
    process.env.HOME = saved;
  }
  dispose();
  assert.equal(r.list().length, 0);
});

test('a harness the app cannot run now takes no switch, as the orchestrator says', async () => {
  const s = setup();
  s.live.controller.state.patch = () => assert.fail('nothing is recorded');
  await assert.rejects(s.host.switchHarness('cl', { harness: 'acp:kimi' }), { code: 'unavailable' });
});
