// A phone moves a chat on a machine to another agent there (electron/app/chromePanelMachine.cjs, wired in app/chromePanel.cjs): options.get adds the machine's agents with their state, the agent the chat runs on and a held move (A); chat.switch reaches the Host now and mirrors what it holds, or says why not, never a silent no-op (W, B); a chat of this Mac keeps its own path (I).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPanelMachine, agentOfChat } = require('../electron/app/chromePanelMachine.cjs');
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-panel-machine-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const U = '3f2b6f58-4a1e-4e0b-9b7c-1d2e3f4a5b6c';
const CLAUDE_CHAT = `acp:host-claude:${U}`;
const ROW = {
  id: 'ssh:box',
  name: 'Box',
  agents: [
    { id: 'claude', label: 'Claude Code', state: 'ready', reason: '' },
    { id: 'codex', label: 'Codex', state: 'signin', reason: 'Sign in on Box' },
    { id: 'gemini', label: 'Gemini CLI', state: 'ready' },
    { id: 'amp', label: 'Amp', state: null, reason: 'Not installed on Box' },
  ],
};

/** What main holds for the panel: the machines, where each chat runs, the Host's connection and the chat's session state. */
function world(o: { owner?: string; sent?: any; row?: any; noService?: boolean; gate?: boolean } = {}) {
  const asked: any[] = [];
  const sessions = new Map<string, any>();
  const patches: any[] = [];
  const live: any = {
    hostPhone: {
      hostOf: (chatId: string) => (o.gate === false || chatId !== CLAUDE_CHAT ? 'local' : (o.owner ?? 'ssh:box')),
      rows: () => [o.row ?? ROW],
    },
    remoteSend: () =>
      o.noService
        ? undefined
        : {
            switchTo: (...a: any[]) => {
              asked.push(a);
              return typeof o.sent === 'function'
                ? o.sent(...a)
                : Promise.resolve(o.sent === undefined ? { pending: { harness: a[1].harness } } : o.sent);
            },
          },
    controller: {
      state: {
        get: (id: string) => sessions.get(id),
        patch: (id: string, p: any) => (patches.push([id, p]), sessions.set(id, { ...sessions.get(id), ...p })),
      },
    },
  };
  const machine = createPanelMachine({ live, labelOf: (k: string | null) => (k ? `label:${k}` : null) });
  return { machine, asked, sessions, patches };
}

test('A: a chat on a machine knows the agent it runs on from its id, and every other id names none', () => {
  assert.equal(agentOfChat(CLAUDE_CHAT), 'claude');
  assert.equal(agentOfChat(`acp:host-codex:${U}`), 'codex');
  assert.equal(agentOfChat(`acp:kimi:${U}`), 'acp:kimi');
  assert.equal(agentOfChat('plain-id'), null);
});

test("A: the options add the machine's agents by the names the wire moves a chat with, with the machine's own words for what is not ready", () => {
  const w = world();
  const out = w.machine.options({ chatId: CLAUDE_CHAT }, { model: null, models: [], harnessId: 'acp:host-claude', switching: false });
  assert.equal(out.harnessId, 'claude');
  assert.equal(out.harness, 'label:claude');
  assert.equal(out.current, 'claude');
  assert.equal(out.switching, false);
  assert.deepEqual(out.machine, {
    id: 'ssh:box',
    name: 'Box',
    agents: [
      { id: 'claude', label: 'Claude Code', state: 'ready', reason: '' },
      { id: 'codex', label: 'Codex', state: 'signin', reason: 'Sign in on Box' },
      { id: 'acp:gemini', label: 'Gemini CLI', state: 'ready', reason: '' },
      { id: 'acp:amp', label: 'Amp', state: 'missing', reason: 'Not installed on Box' },
    ],
  });
  // a held move: the menu is for the agent it goes to, and says so
  w.sessions.set(CLAUDE_CHAT, { pendingSwitch: { harness: 'codex' } });
  const held = w.machine.options({ chatId: CLAUDE_CHAT }, {});
  assert.deepEqual([held.harnessId, held.harness, held.current, held.switching], ['codex', 'label:codex', 'claude', true]);
});

test('I: a chat of this Mac, a new chat, a gate that is closed and a machine that is not listed are returned as they were', () => {
  const reply = { model: 'x' };
  assert.equal(world().machine.options({ chatId: 'local-chat' }, reply), reply);
  assert.equal(world().machine.options({}, reply), reply);
  assert.equal(world({ gate: false }).machine.options({ chatId: CLAUDE_CHAT }, reply), reply);
  const gone = world();
  gone.machine = createPanelMachine({
    live: { hostPhone: { hostOf: () => 'ssh:other', rows: () => [ROW] } },
    labelOf: () => null,
  });
  assert.equal(gone.machine.options({ chatId: CLAUDE_CHAT }, reply), reply);
  // an id that names no agent keeps the reply's own harness; a row with no agents lists none
  const plain = createPanelMachine({
    live: {
      hostPhone: { hostOf: () => 'ssh:box', rows: () => [{ id: 'ssh:box', name: 'Box' }] },
      controller: { state: { get: () => undefined } },
    },
    labelOf: () => null,
  });
  const shown = plain.options({ chatId: 'odd-id' }, { harnessId: 'x', harness: 'X' });
  assert.deepEqual([shown.harnessId, shown.harness, shown.current, shown.machine.agents], ['x', 'X', undefined, []]);
});

test("W: the move reaches the machine's Host now, and the session mirrors what the Host holds (the chip, and the next read)", async () => {
  const w = world();
  assert.equal(await w.machine.switchTo({ chatId: CLAUDE_CHAT, harness: 'codex' }), true);
  assert.deepEqual(w.asked, [[CLAUDE_CHAT, { harness: 'codex' }]]);
  assert.deepEqual(w.patches, [[CLAUDE_CHAT, { pendingSwitch: { harness: 'codex', model: '', modelLabel: '', mode: 'auto' } }]]);
  // the Host's own pick of a model rides along
  const picked = world({ sent: { pending: { harness: 'acp:gemini', model: 'g-2' } } });
  await picked.machine.switchTo({ chatId: CLAUDE_CHAT, harness: 'acp:gemini' });
  assert.equal(picked.patches[0][1].pendingSwitch.model, 'g-2');
  // its own agent again: the Host drops the choice and so does the mirror
  const back = world({ sent: { pending: null } });
  await back.machine.switchTo({ chatId: CLAUDE_CHAT, harness: 'claude' });
  assert.deepEqual(back.patches, [[CLAUDE_CHAT, { pendingSwitch: null }]]);
  // an answer that names nothing holds nothing
  const bare = world({ sent: null });
  await bare.machine.switchTo({ chatId: CLAUDE_CHAT, harness: 'codex' });
  assert.deepEqual(bare.patches, [[CLAUDE_CHAT, { pendingSwitch: null }]]);
});

test('B: a Host that refuses says why in its own words, an older Host is told to update, and a machine out of reach changes nothing', async () => {
  const refused = world({
    sent: () => Promise.reject(Object.assign(new Error('Codex is not installed on this machine.'), { code: 'agent_missing' })),
  });
  await assert.rejects(refused.machine.switchTo({ chatId: CLAUDE_CHAT, harness: 'codex' }), {
    message: 'Codex is not installed on this machine.',
  });
  const old = world({
    sent: () => Promise.reject(Object.assign(new Error('The host cannot do this safely yet'), { code: 'feature_missing' })),
  });
  await assert.rejects(old.machine.switchTo({ chatId: CLAUDE_CHAT, harness: 'codex' }), { message: 'Update Box to switch agents.' });
  // no connection to ask: the service answers null (the chat runs here) or is absent (Host is off)
  const away = world({ sent: () => null });
  await assert.rejects(away.machine.switchTo({ chatId: CLAUDE_CHAT, harness: 'codex' }), {
    message: "Can't reach Box, so the chat stays on its agent.",
  });
  const off = world({ noService: true });
  await assert.rejects(off.machine.switchTo({ chatId: CLAUDE_CHAT, harness: 'codex' }), /Can't reach Box/);
  // a login for a machine is picked on the Mac, so a phone that names one is told so and nothing is asked
  const login = world();
  await assert.rejects(login.machine.switchTo({ chatId: CLAUDE_CHAT, harness: 'codex', account: 'a1' }), /picked on your Mac/);
  assert.deepEqual([refused.patches, old.patches, away.patches, off.patches, login.patches, login.asked], [[], [], [], [], [], []]);
});

test('I: a chat of this Mac is left to the app: nothing is asked of a machine', async () => {
  const w = world();
  assert.equal(await w.machine.switchTo({ chatId: 'local-chat', harness: 'codex' }), undefined);
  assert.equal(await world({ gate: false }).machine.switchTo({ chatId: CLAUDE_CHAT, harness: 'codex' }), undefined);
  assert.deepEqual(w.asked, []);
});

/** The panel main builds for the phone, over a chat on a machine whose own menus have nothing to say about it. */
function wired(o: { held?: any; local?: boolean } = {}) {
  const records = new Map<string, any>([
    [CLAUDE_CHAT, { id: CLAUDE_CHAT, segments: [{ kind: 'acp:host-claude', nativeId: CLAUDE_CHAT }], meta: {} }],
  ]);
  const sessions = new Map<string, any>([[CLAUDE_CHAT, { turn: 'idle', ...(o.held ? { pendingSwitch: o.held } : {}) }]]);
  const asked: any[] = [];
  const live: any = {
    chats: { records, patchMeta: () => true },
    controller: {
      state: {
        get: (id: string) => sessions.get(id),
        has: (id: string) => sessions.has(id),
        patch: (id: string, p: any) => void sessions.set(id, { ...sessions.get(id), ...p }),
      },
      ref: (id: string) => ({ key: id, kind: 'acp:host-claude' }),
    },
    acpAdmission: { list: () => [], admitted: () => false },
    hostPhone: { hostOf: () => (o.local ? 'local' : 'ssh:box'), rows: () => [ROW] },
    remoteSend: () => ({ switchTo: (...a: any[]) => (asked.push(a), Promise.resolve({ pending: { harness: a[1].harness } })) }),
  };
  const panel = createChromePanel({
    live,
    sources: { codex: async () => [], claude: async () => [], acp: async () => [] },
    projectsFile: projectsFileOf(scratch),
    home: scratch,
    prefs: () => ({ projectlessFolder: path.join(scratch, 'chats') }),
    usable: async () => true,
    starter: { prefs: () => ({}), chats: live.chats, started: () => undefined },
    send: async () => ({ action: 'started', id: 'x' }),
    open: () => undefined,
    now: () => new Date('2026-10-21T10:00:00Z'),
  });
  return { ops: panel.service.ops, sessions, asked };
}

test("W: main's panel adds the machine to the options, and a move held for the chat is the machine's, never a menu of this Mac's", async () => {
  const idle = wired();
  const before = await idle.ops.options({ chatId: CLAUDE_CHAT });
  assert.equal(before.machine.name, 'Box');
  assert.equal(before.harnessId, 'claude');
  assert.equal(before.switching, false);
  // the choice a phone makes reaches the machine and shows on the next read, with the menus still the chat's own
  await idle.ops.switchHarness({ chatId: CLAUDE_CHAT, harness: 'codex' });
  assert.deepEqual(idle.asked, [[CLAUDE_CHAT, { harness: 'codex' }]]);
  const after = await idle.ops.options({ chatId: CLAUDE_CHAT });
  assert.deepEqual([after.harnessId, after.switching, after.current], ['codex', true, 'claude']);
  // a choice made in the app's window is held the same way, and reads the same
  const held = wired({ held: { harness: 'codex', model: '', modelLabel: '', mode: 'auto' } });
  const shown = await held.ops.options({ chatId: CLAUDE_CHAT });
  assert.deepEqual([shown.harnessId, shown.switching], ['codex', true]);
  assert.equal(shown.model ?? null, null, 'the menus are not the held target’s (this Mac’s Codex models)');
});

test("I: through main's panel a chat of this Mac is moved by the app's own menus, and the machine is never asked", async () => {
  const local = wired({ local: true });
  const out: any = await local.ops.switchHarness({ chatId: CLAUDE_CHAT, harness: 'codex' }).then(
    (r: unknown) => ({ ok: r }),
    (e: Error) => ({ refused: e.message }),
  );
  assert.deepEqual(local.asked, []);
  assert.ok('ok' in out || 'refused' in out);
  assert.equal(/Box/.test(JSON.stringify(out)), false);
});

test('A: a machine chat whose agent its id does not name is shown without one, and with no move held', () => {
  const live: any = {
    hostPhone: { hostOf: () => 'ssh:box', rows: () => [ROW] },
    controller: { state: { get: () => undefined, patch: () => undefined } },
  };
  const machine = createPanelMachine({ live, labelOf: () => null });
  const out = machine.options({ chatId: 'unnamed' }, { models: [] });
  assert.equal(out.switching, false);
  assert.equal('harnessId' in out, false);
  assert.equal('current' in out, false);
  assert.equal(out.machine.name, 'Box');
});

test('A: an agent the app has no name for is shown by its own id', () => {
  const live: any = {
    hostPhone: { hostOf: () => 'ssh:box', rows: () => [ROW] },
    controller: { state: { get: () => ({ pendingSwitch: { harness: 'acp:odd' } }), patch: () => undefined } },
  };
  const out = createPanelMachine({ live, labelOf: () => null }).options({ chatId: 'unnamed' }, { models: [] });
  assert.deepEqual([out.harnessId, out.harness, out.switching], ['acp:odd', 'acp:odd', true]);
});
