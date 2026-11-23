// An unattended run (a scheduled task, a goal's own round) asks for desktop access through desktop_request_access
// (Claude Code: request_access on mopilot_computer; Codex and ACP: desktop_request_access): the call is refused and
// the chat paused, and the access card that call would have shown is put up once the user opens the chat. Allow
// grants what it asked for, so the run's next call goes through. Runs main's real wiring (setupComputerUse) over a
// fake helper socket, once per harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeHelper } from './e2e/fixtures/fake-helper.ts';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { setupComputerUse, PARITY_FLAG, FLAG } = require('../electron/capabilities/computerUse.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { placement } = require('../electron/capabilities/contract/hostServers.cjs');

const SCHEDULED = { scheduled: { unattended: true, computer: true, onApproval: 'wait' } };

async function rig(o: { kind?: string; flags?: Record<string, boolean>; shown?: (id: string) => boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-deferred-'));
  const sock = path.join(dir, 'h.sock');
  const fake = await startFakeHelper(sock);
  const flags: Record<string, boolean> = { [FLAG]: true, [PARITY_FLAG]: true, 'shared.computerUse.unattended': true, ...o.flags };
  const handlers = new Map<string, Function>();
  const approvals: any[] = [];
  const controller = {
    chatOf: (id: string) => id,
    ref: () => ({ kind: o.kind ?? 'codex' }),
    isSubagentCall: () => false,
    // main's controller.viewing: only a focused window counts
    viewing: () => false,
    addApproval: (_c: string, a: any) => approvals.push(a),
    resolveApproval: (id: string) => {
      const i = approvals.findIndex((a) => a.id === id);
      if (i >= 0) approvals.splice(i, 1);
      return true;
    },
  };
  // the run nobody attends: a scheduled task's chat, with its turn in flight until the test ends it
  const state: any = { ...SCHEDULED, activeTurn: { human: false } };
  const sessions = { get: () => state, patch: () => {} };
  const meta = new Map<string, any>();
  const chats: any = {
    records: new Map(),
    get: (id: string) => (meta.has(id) ? { meta: meta.get(id) } : null),
    patchMeta: (id: string, p: any) => (meta.set(id, { ...(meta.get(id) ?? {}), ...p }), true),
  };
  const stops: string[] = [];
  const notified: any[] = [];
  const registry = new Registry();
  const prev = process.env.SAGE_CU_FAKE_HELPER;
  process.env.SAGE_CU_FAKE_HELPER = sock;
  let runtime: any;
  try {
    runtime = setupComputerUse({
      ipcMain: { handle: (name: string, fn: Function) => handlers.set(name, fn) },
      registry,
      flags: { isEnabled: (k: string) => !!flags[k] },
      chats,
      controller,
      sessions,
      userData: dir,
      packaged: false,
      broadcast: () => {},
      stop: async (chatId: string) => {
        stops.push(chatId);
        // Main stops the turn through the controller, whose interrupt hook aborts its running tool calls.
        registry.abortChat(chatId, 'stopped');
      },
      notify: (chatId: string, app: string) => notified.push([chatId, app]),
      // main's chatShown: a window still shows the chat, focused or not
      shown: o.shown ?? (() => true),
    });
  } finally {
    if (prev === undefined) delete process.env.SAGE_CU_FAKE_HELPER;
    else process.env.SAGE_CU_FAKE_HELPER = prev;
  }
  runtime.cu.settleMs = 0;
  runtime.desktop.settleMs = 0;
  /** the turn ends (Stop interrupted it), as main patches the session */
  const endTurn = () => {
    delete state.activeTurn;
    runtime.onSessionPatch({ chatId: 'c1', patch: { turn: 'idle' } });
  };
  const answer = async (result: any) => {
    await handlers.get('computer:answer')!({}, approvals[0].id, result);
    await tick();
    await tick();
  };
  const invoke = (tool: string, args: any) => registry.invoke('c1', 's1', tool, args);
  return {
    runtime,
    fake,
    flags,
    state,
    approvals,
    stops,
    notified,
    endTurn,
    answer,
    invoke,
    done: async () => {
      runtime.stop();
      await fake.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The Registry tool a harness calls for desktop access: Claude Code's request_access on mopilot_computer is desktop_request_access. */
const REQUEST_ACCESS: Record<string, string> = {
  claude: 'desktop_request_access',
  codex: 'desktop_request_access',
  'acp:gemini': 'desktop_request_access',
};

test('Claude Code calls it request_access on mopilot_computer; it is the same Registry tool', () => {
  assert.deepEqual(placement('desktop_request_access', 'sage_x'), { server: 'mopilot_computer', name: 'request_access' });
  assert.deepEqual(placement('desktop_app_screenshot', 'sage_x'), { server: 'mopilot_computer', name: 'app_screenshot' });
});

for (const kind of ['codex', 'claude', 'acp:gemini']) {
  test(`${kind}: unattended request_access is refused and recorded; opening the chat shows the access card; Allow lets the next call run`, async () => {
    const r = await rig({ kind });
    try {
      const refused = await r.invoke(REQUEST_ACCESS[kind], { apps: ['Notes'], reason: 'Check the nightly note', clipboardRead: true });
      assert.equal(refused.ok, false);
      assert.equal(refused.error.code, 'unattended');
      assert.match(refused.error.message, /Access to Notes needs the user's OK, and nobody is here to give it \(a scheduled task\)/);
      // paused and told once; no card while nobody is there
      await tick();
      assert.deepEqual(r.stops, ['c1']);
      assert.deepEqual(r.notified, [['c1', 'Notes']]);
      assert.equal(r.approvals.length, 0);
      // the user opens the run while the interrupted turn is still ending: the card waits for its end
      r.runtime.onViewed('c1');
      assert.equal(r.approvals.length, 0);
      r.endTurn();
      assert.equal(r.approvals.length, 1, 'the card goes up once the turn has ended, with the window unfocused');
      const card = r.approvals[0];
      assert.equal(card.method, 'sage/computerAccessSet');
      assert.equal(card.params.harness, kind);
      assert.deepEqual(
        card.params.apps.map((a: any) => [a.bundleId, a.tier]),
        [['com.apple.Notes', 'full']],
      );
      assert.equal(card.params.reason, 'Check the nightly note');
      assert.equal(card.params.clipboardRead, true);
      assert.equal('takeover' in card.params, false, 'screen control is asked just in time, not here');
      // a second look raises no second card
      r.runtime.onViewed('c1');
      assert.equal(r.approvals.length, 1);
      await r.answer({ decision: 'allow', takeover: true });
      assert.equal(r.approvals.length, 0);
      const s = r.runtime.desktop.session('c1');
      assert.deepEqual([...s.apps.keys()], ['com.apple.notes']);
      assert.equal(s.clipboardRead, true);
      assert.equal(s.consent, false);
      // Resume: the run's next calls, still with nobody there, go through without a card
      const again = await r.invoke(REQUEST_ACCESS[kind], { apps: ['Notes'], reason: 'Check the nightly note' });
      assert.equal(again.ok, true, JSON.stringify(again.error));
      assert.deepEqual(
        JSON.parse(again.content[0].text).granted.map((g: any) => g.bundleId),
        ['com.apple.Notes'],
      );
      const shot = await r.invoke('desktop_app_screenshot', { app: 'Notes' });
      assert.equal(shot.ok, true, JSON.stringify(shot.error));
      assert.equal(r.approvals.length, 0);
      // answered: opening the chat again shows nothing
      r.runtime.onViewed('c1');
      assert.equal(r.approvals.length, 0);
    } finally {
      await r.done();
    }
  });
}

test('Deny on the deferred access card grants nothing and the refusal is gone', async () => {
  const r = await rig();
  try {
    await r.invoke('desktop_request_access', { apps: ['Notes'], reason: 'r' });
    r.endTurn();
    r.runtime.onViewed('c1');
    assert.equal(r.approvals[0].method, 'sage/computerAccessSet');
    await r.answer({ decision: 'deny' });
    assert.equal(r.runtime.desktop.granted('c1').size, 0);
    r.runtime.onViewed('c1');
    assert.equal(r.approvals.length, 0);
  } finally {
    await r.done();
  }
});

test('Always allow on the deferred card remembers the app for every chat', async () => {
  const r = await rig();
  try {
    await r.invoke('desktop_request_access', { apps: ['Notes'], reason: 'r' });
    r.endTurn();
    r.runtime.onViewed('c1');
    await r.answer({ decision: 'allow', remember: true });
    assert.deepEqual(
      r.runtime.grants.global().map((g: any) => [g.bundleId, g.level]),
      [['com.apple.Notes', 'full']],
    );
  } finally {
    await r.done();
  }
});

test('the desktop tools switched off since the refusal: no deferred card', async () => {
  const r = await rig();
  try {
    await r.invoke('desktop_request_access', { apps: ['Notes'], reason: 'r' });
    // the chat is on screen as it pauses, so its card would go up when the stopped turn ends: switched off by then, none does
    r.flags[PARITY_FLAG] = false;
    r.endTurn();
    r.runtime.onViewed('c1');
    assert.equal(r.approvals.length, 0);
    // back on: the refusal is still there for the next look
    r.flags[PARITY_FLAG] = true;
    r.runtime.onViewed('c1');
    assert.equal(r.approvals.length, 1);
  } finally {
    await r.done();
  }
});

test('focus-independent: a chat the user opened gets its card at turn end while a window still shows it, focused or not', async () => {
  let showing = true;
  const r = await rig({ shown: () => showing });
  try {
    await r.invoke('desktop_request_access', { apps: ['Notes'], reason: 'r' });
    r.runtime.onViewed('c1');
    r.endTurn();
    assert.equal(r.approvals.length, 1);
  } finally {
    await r.done();
  }
  // the user moved on to another chat before the turn ended: no card until they come back
  showing = false;
  const away = await rig({ shown: () => showing });
  try {
    await away.invoke('desktop_request_access', { apps: ['Notes'], reason: 'r' });
    away.runtime.onViewed('c1');
    away.endTurn();
    assert.equal(away.approvals.length, 0);
    away.runtime.onViewed('c1');
    assert.equal(away.approvals.length, 1);
  } finally {
    await away.done();
  }
});

test('display-scope input unattended without takeover consent: the takeover card is deferred and Allow gives screen control', async () => {
  const r = await rig();
  try {
    // Notes was granted earlier in this chat (by the user, or a card answered before)
    r.runtime.desktop.session('c1').apps.set('com.apple.notes', { bundleId: 'com.apple.Notes', name: 'Notes', tier: 'full' });
    const refused = await r.invoke('desktop_mouse_move', { coordinate: [1, 1] });
    assert.equal(refused.error.code, 'unattended');
    assert.match(refused.error.message, /Taking over the screen needs the user's OK/);
    r.endTurn();
    r.runtime.onViewed('c1');
    assert.equal(r.approvals[0].method, 'sage/computerTakeover');
    assert.deepEqual(r.approvals[0].params.apps, [{ bundleId: 'com.apple.Notes', name: 'Notes', tier: 'full' }]);
    await r.answer({ decision: 'allow' });
    assert.equal(r.runtime.desktop.session('c1').consent, true);
  } finally {
    await r.done();
  }
  const deny = await rig();
  try {
    deny.runtime.desktop.session('c1').apps.set('com.apple.notes', { bundleId: 'com.apple.Notes', name: 'Notes', tier: 'full' });
    await deny.invoke('desktop_mouse_move', { coordinate: [1, 1] });
    deny.endTurn();
    deny.runtime.onViewed('c1');
    await deny.answer({ decision: 'deny' });
    assert.equal(deny.runtime.desktop.session('c1').consent, false);
  } finally {
    await deny.done();
  }
});
