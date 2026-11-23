// The directory and host tools in main (electron/app/hostToolsWiring.cjs): the same tools for a Claude, Codex and ACP chat with
// no window open, the card going through the chat's approvals, and a keep-awake hold ending with the session however it ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { registerHostTools } = require('../electron/app/hostToolsWiring.cjs');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-wiring-')));
const worktrees = path.join(root, 'worktrees');
const project = path.join(root, 'project');
const extra = path.join(root, 'extra');
fs.mkdirSync(path.join(worktrees, 'id1', 'repo'), { recursive: true });
fs.mkdirSync(project);
fs.mkdirSync(extra);
fs.writeFileSync(path.join(project, 'a.ts'), 'x');

const KINDS: Record<string, string> = { claude: 'claude', codex: 'codex', acp: 'acp:gemini' };

function setup(
  over: {
    platform?: string;
    winPaths?: Record<string, string>;
    broker?: boolean;
    blocker?: boolean;
    picked?: any;
    prefs?: any;
    deleted?: boolean;
  } = {},
) {
  const records = new Map<string, any>();
  for (const [id, kind] of Object.entries(KINDS)) records.set(id, { meta: { config: {} }, segments: [{ kind }] });
  records.set('momo', { meta: { momo: 'topic' }, segments: [{ kind: 'codex' }] });
  records.set('archived', { meta: { archived: 5 }, segments: [{ kind: 'codex' }] });
  const asked: any[] = [];
  const claudeCalls: any[] = [];
  const live: any = {
    capabilities: new Registry(),
    chats: {
      records,
      onChange: undefined as any,
      patchMeta: (id: string, patch: any) => (records.set(id, { ...records.get(id), meta: { ...records.get(id).meta, ...patch } }), true),
    },
    controller: { ref: (id: string) => ({ kind: KINDS[id] ?? 'codex', key: `${KINDS[id] ?? 'codex'}:k` }) },
    claudeTurns: { api: { isLive: () => true, control: async (...a: any[]) => claudeCalls.push(a) } },
    computerUse:
      over.broker === false
        ? undefined
        : {
            broker: {
              ask: async (chatId: string, kind: string, params: any, o: any) => (
                asked.push([chatId, kind, params, o]), { decision: 'allow', choice: 'allow' }
              ),
            },
          },
    chatDeletion: { onDeleted: undefined as any },
  };
  live.capabilities.setApprover(async () => true);
  const app = new EventEmitter();
  const blocks: string[] = [];
  const shown: string[] = [];
  const runs: any[] = [];
  const hostApi = {
    app,
    dialog: { showOpenDialog: async () => over.picked ?? { canceled: false, filePaths: [extra] } },
    shell: { showItemInFolder: (p: string) => shown.push(p) },
    powerSaveBlocker: over.blocker === false ? undefined : { start: () => (blocks.push('start'), 4), stop: () => void blocks.push('stop') },
  };
  const removedWorktrees: string[] = [];
  const infoAsked: string[] = [];
  let chatFolders: (() => Promise<string[]>) | null = null;
  const gitPlatform = {
    setChatFolders: (fn: () => Promise<string[]>) => (chatFolders = fn),
    rootOf: (r: string) => r,
    listWorktrees: (r: string) =>
      fs.existsSync(r) ? fs.readdirSync(r).map((id) => ({ path: path.join(r, id, 'repo'), repo: '/r', branch: 'b', createdAt: 0 })) : [],
    removeWorktree: async (wt: any) => (removedWorktrees.push(wt.path), true),
    canonical: (p: string) => p,
    worktreeInfo: (p: string) => (infoAsked.push(p), null),
  };
  const wired = registerHostTools({
    live,
    owner: (ctx: any) => (records.has(ctx.chatId) ? ctx.chatId : null),
    projectOf: async (id: string) => (id === 'archived' || id === 'momo' ? worktrees + '/id1/repo' : project),
    prefs: () => over.prefs ?? { worktreeRoot: worktrees },
    hostApi,
    gitPlatform,
    run: async (...a: any[]) => (runs.push(a), { ok: true, stderr: '' }),
    winPaths: over.winPaths,
    platform: over.platform ?? 'darwin',
  });
  const call = async (chat: string, tool: string, args: any) => {
    const res = await live.capabilities.invoke(chat, 'seg', tool, args);
    return res.ok ? res.content[0].text : `ERROR ${res.error.code}: ${res.error.message}`;
  };
  return {
    live,
    wired,
    asked,
    claudeCalls,
    app,
    blocks,
    shown,
    runs,
    call,
    records,
    removedWorktrees,
    infoAsked,
    chatFolders: () => chatFolders!(),
  };
}

test('git prune is given every live chat folder from main: archived and MoMo chats left out', async () => {
  const t = setup();
  assert.deepEqual(await t.chatFolders(), [project, project, project]);
  t.wired.dispose();
});

test('all ten tools are there for every chat, and no window is needed for any of them', () => {
  const t = setup();
  assert.deepEqual(
    t.live.capabilities.list().map((x: any) => x.name),
    [
      'request_directory',
      'change_directory',
      'propose_branch',
      'open_in_editor',
      'reveal_path',
      'request_keep_awake',
      'get_storage_usage',
      'clean_up_worktrees',
      'discard_kept_worktree',
      'sync_with_base_branch',
    ],
  );
  t.wired.dispose();
  assert.deepEqual(t.live.capabilities.list(), []);
});

test("propose_branch checks the chat's folder against the managed worktrees before it asks", async () => {
  const t = setup();
  await t.call('claude', 'propose_branch', { suggested: 'fix/a' });
  assert.deepEqual(t.infoAsked, [project]);
});

test('request_directory works the same on each harness and tells the model what that harness does with the folder', async () => {
  const t = setup();
  const text: Record<string, string> = {};
  for (const chat of Object.keys(KINDS)) text[chat] = await t.call(chat, 'request_directory', { path: extra });
  for (const chat of Object.keys(KINDS)) assert.match(text[chat], new RegExp(`^Folder access granted: ${extra}`), chat);
  assert.doesNotMatch(text.claude, /next turn/);
  assert.match(text.codex, /This harness applies it from the next turn/);
  assert.match(text.acp, /may still ask for approval/);
  assert.deepEqual(t.claudeCalls, [['claude:k', 'addDirectories', [extra]]], "only Claude's live process takes it at once");
  for (const chat of Object.keys(KINDS)) assert.deepEqual(t.records.get(chat).meta.config.additionalDirectories, [extra], chat);
  // the card went through the chat's own approvals, with the harness it came from
  assert.deepEqual(
    t.asked.map((a) => [a[0], a[1], a[2].harness, a[2].title]),
    [
      ['claude', 'hostAsk', 'claude', 'Folder access'],
      ['codex', 'hostAsk', 'codex', 'Folder access'],
      ['acp', 'hostAsk', 'acp:gemini', 'Folder access'],
    ],
  );
  // the granted folder now counts as the session's: its files can be shown
  assert.match(await t.call('codex', 'reveal_path', { path: extra }), /^Revealed folder/);
  assert.deepEqual(t.shown, [extra]);
});

test('without an approval broker the card cannot be shown, so nothing is granted or opened', async () => {
  const t = setup({ broker: false });
  assert.match(await t.call('codex', 'request_directory', { path: extra }), /^ERROR denied/);
  assert.match(await t.call('codex', 'reveal_path', { path: project }), /^ERROR denied/);
  assert.deepEqual(t.records.get('codex').meta.config, {});
});

test('the folder picker, the editor choice and the file manager name follow the app and the platform', async () => {
  const t = setup({ prefs: { worktreeRoot: worktrees, openDestination: 'vscode' } });
  assert.match(await t.call('codex', 'request_directory', {}), /^Folder access granted: /);
  assert.equal(t.asked.length, 0, 'the picker is the approval');
  assert.equal(
    await setup({ picked: { canceled: true, filePaths: [] } }).call('codex', 'request_directory', {}),
    'Directory selection was cancelled by the user.',
  );
  assert.equal(
    await setup({ picked: { canceled: false, filePaths: [] } }).call('codex', 'request_directory', {}),
    'Directory selection was cancelled by the user.',
  );
  assert.match(await setup({ platform: 'win32' }).call('codex', 'reveal_path', { path: project }), /in File Explorer\.$/);
  assert.match(await setup({ platform: 'linux' }).call('codex', 'reveal_path', { path: project }), /in the file manager\.$/);
  // an editor installed (Windows paths here, so the test does not depend on this Mac): the Settings choice or the only one
  const exe = path.join(project, 'a.ts');
  for (const openDestination of ['vscode', 'finder']) {
    const e = setup({ platform: 'win32', winPaths: { vscode: exe }, prefs: { openDestination } });
    assert.match(await e.call('codex', 'open_in_editor', { path: 'a.ts', line: 2 }), /^Asked VS Code to open .*a\.ts at line 2\.$/);
    assert.deepEqual(e.runs, [[exe, ['--goto', `${exe}:2`]]]);
  }
});

test('get_storage_usage reads the worktree folder from the settings, with chats that are not archived counted as using theirs', async () => {
  const t = setup();
  const out = JSON.parse(await t.call('codex', 'get_storage_usage', { refresh: true }));
  assert.equal(out.worktrees.count, 1);
  assert.equal(out.worktrees.in_use_count, 0, 'the only chat in that worktree is archived');
  assert.equal(typeof out.free_bytes, 'number');
  t.records.set('archived', { meta: {}, segments: [{ kind: 'codex' }] });
  const busy = JSON.parse(await t.call('codex', 'get_storage_usage', { refresh: true }));
  assert.equal(busy.worktrees.in_use_count, 1, 'restored: it works there again');
  // a worktree folder that does not exist yet has no worktrees and no free-space reading
  const none = setup({ prefs: { worktreeRoot: path.join(root, 'missing') } });
  const empty = JSON.parse(await none.call('codex', 'get_storage_usage', {}));
  assert.equal(empty.worktrees.count, 0);
  assert.equal('free_bytes' in empty, false);
});

test('a keep-awake hold ends with its turn, and with the session however that ends: stop, crash, deletion, archive, quit', async () => {
  const hold = (t: any, chat: string, until = 'session_idle') => t.call(chat, 'request_keep_awake', { until, reason: 'CI' });
  // the turn the call was made in finishes
  let t = setup();
  await hold(t, 'claude', 'turn_end');
  assert.equal(t.wired.keepAwake.isHeld('claude'), true);
  await t.live.controller.onFinished({ chatId: 'claude' });
  assert.equal(t.wired.keepAwake.isHeld('claude'), false);
  assert.deepEqual(t.blocks, ['start', 'stop']);
  // an idle-session hold survives its turn and a new turn's start, but not the end of the session
  const ends: Record<string, (t: any) => void> = {
    stop: (x) => x.live.controller.onStopped('codex'),
    crash: (x) => x.live.controller.onCrash('codex'),
    delete: (x) => x.live.chatDeletion.onDeleted({ chatId: 'codex' }),
    archive: (x) => x.live.chats.onChange('codex', { meta: { archived: 9 } }),
    quit: (x) => x.app.emit('will-quit'),
  };
  for (const [name, end] of Object.entries(ends)) {
    t = setup();
    await hold(t, 'codex');
    await t.live.controller.onFinished({ chatId: 'codex' });
    await t.live.controller.beforeDispatch({ chatId: 'codex' });
    assert.equal(t.wired.keepAwake.isHeld('codex'), true, `${name}: held across turns`);
    end(t);
    assert.equal(t.wired.keepAwake.isHeld('codex'), false, name);
    assert.deepEqual(t.blocks, ['start', 'stop'], `${name}: the computer may sleep again`);
  }
  // a chat that is edited but not archived keeps its hold
  t = setup();
  await hold(t, 'acp');
  t.live.chats.onChange('acp', { meta: { archived: null } });
  t.live.chats.onChange('acp', undefined);
  assert.equal(t.wired.keepAwake.isHeld('acp'), true);
  t.wired.dispose();
  assert.equal(t.wired.keepAwake.isHeld('acp'), false, 'removing the tools lets go too');
});

test('an app without a power-save blocker refuses to hold instead of pretending', async () => {
  const t = setup({ blocker: false });
  assert.match(await t.call('codex', 'request_keep_awake', { until: 'turn_end', reason: 'x' }), /^ERROR unavailable/);
});

test('a chat that is not deleted keeps its hold when another is', async () => {
  const t = setup();
  await t.call('codex', 'request_keep_awake', { until: 'session_idle', reason: 'x' });
  await t.call('claude', 'request_keep_awake', { until: 'session_idle', reason: 'x' });
  t.live.chatDeletion.onDeleted({ chatId: 'claude' });
  assert.equal(t.wired.keepAwake.isHeld('codex'), true);
  assert.deepEqual(t.blocks, ['start'], 'one OS blocker still held for the other chat');
});

test('with no deletion service and a real timer the wiring still comes up', async () => {
  const t = setup();
  t.wired.dispose();
  const registry = new Registry();
  registry.setApprover(async () => true);
  const live: any = {
    capabilities: registry,
    chats: { records: new Map(), onChange: undefined },
    controller: { ref: () => ({ kind: 'codex', key: 'k' }) },
  };
  const wired = registerHostTools({
    live,
    owner: () => 'c',
    projectOf: async () => null,
    prefs: () => ({}),
    hostApi: { app: new EventEmitter(), dialog: {}, shell: {} },
    gitPlatform: {
      rootOf: () => null,
      listWorktrees: () => [],
      removeWorktree: async () => true,
      canonical: (p: string) => p,
      worktreeInfo: () => null,
    },
    run: async () => ({ ok: true, stderr: '' }),
  });
  assert.equal(wired.keepAwake.available, false);
  assert.deepEqual(JSON.parse((await registry.invoke('c', 'seg', 'get_storage_usage', {})).content[0].text).worktrees.count, 0);
  wired.dispose();
});

test('the worktree tools reach the platform: a discard removes through it and a base-branch sync asks it about the folder', async () => {
  const t = setup();
  const wt = path.join(worktrees, 'id1', 'repo');
  assert.match(await t.call('codex', 'discard_kept_worktree', { path: wt }), /^Deleted the worktree/);
  assert.deepEqual(t.removedWorktrees, [wt]);
  assert.match(await t.call('codex', 'sync_with_base_branch', {}), /^ERROR not_managed/);
  assert.deepEqual(t.infoAsked, [project]);
});
