// Main app wiring exposes real start approvals, notifications, notes, snapshot lineage and archive/plan guards without a window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { orchestration } from './support/orchestration-harness.ts';
const require = createRequire(import.meta.url);
const { createOrchestration, orchestrationView } = require('../electron/app/orchestration.cjs');
function fixture(t: any, more: Record<string, unknown> = {}) {
  const h = orchestration();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-app-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handlers = new Map<string, any>(),
    calls: any[] = [];
  let decision = 'allow';
  h.records.set('top', { id: 'top', segments: [], meta: {} });
  const chats: any = h.orch.o.chats;
  chats.patchMeta = (id: string, patch: any) => {
    const rec = h.records.get(id);
    h.records.set(id, { ...rec, meta: { ...rec.meta, ...patch } });
    return true;
  };
  const controller: any = h.controller;
  controller.chatOf = (key: string) => key;
  const live: any = {
    controller,
    chats,
    peerRuntime: { readReference: async () => ({ turns: [] }), referenceWindow: (event: any) => event.sender === 'app' },
    computerUse: {
      broker: {
        ask: async (...a: any[]) => {
          calls.push(a);
          return { decision };
        },
      },
    },
    notifier: { notify: (...a: any[]) => calls.push(a) },
    codex: { chatName: () => null },
    ...more,
  };
  const orch = createOrchestration({
    file: path.join(dir, 'orchestration.json'),
    live,
    prefs: () => ({ permission: 'default' }),
    starter: { prefs: () => ({}) },
    usable: async () => true,
    send: async () => ({ started: true }),
    projectOf: async () => dir,
    worktreeInfo: () => null,
    owner: (c: any) => c.chatId,
    ipcMain: { handle: (name: string, fn: any) => handlers.set(name, fn) },
    broadcastAll: (...a: any[]) => calls.push(a),
  });
  return {
    ...h,
    controller,
    orch,
    live,
    dir,
    calls,
    handlers,
    decision: (d: string) => {
      decision = d;
    },
  };
}

test('start approvals carry the real parent harness and abort signal; no broker and denial never authorize', async (t) => {
  const f = fixture(t);
  assert.equal(f.orch.o.mainRepair(), undefined);
  f.live.mainRepair = { api: { status: 'available' } };
  assert.equal(f.orch.o.mainRepair(), f.live.mainRepair.api);
  const signal = new AbortController().signal;
  assert.equal(await f.orch.o.approveStart('top', { count: 10, continued: true, signal }), true);
  assert.deepEqual(f.calls[0], ['top', 'sessionStart', { harness: 'codex', count: 10, continued: true }, { signal }]);
  f.decision('deny');
  assert.equal(await f.orch.o.approveStart('top', { count: 11, continued: false, signal }), false);
  f.live.computerUse = null;
  assert.equal(await f.orch.o.approveStart('top', { count: 12, continued: false, signal }), false);
  f.orch.o.notifyOffer('top', 'A task');
  assert.deepEqual(f.calls.at(-1), [
    'approval',
    'top',
    { title: 'New session for “A task”, or do it here?', body: 'With no answer in a minute, it’s done here.' },
  ]);
  f.live.notifier = null;
  assert.equal(f.orch.o.notifyOffer('top', 'A task'), undefined);
});

test('real notes and inherited options are wired without UI, and archived linked input is rejected before dispatch', async (t) => {
  const f = fixture(t);
  const opts = await f.orch.o.childOptions('top', 'codex', {});
  assert.equal(opts.permission, 'default');
  const notes = await f.orch.o.prepareNotes('top');
  assert.ok(fs.statSync(notes.path).isDirectory());
  assert.equal(f.orch.o.notesDirectory('top'), notes.path);
  assert.equal((await f.orch.o.grantParentNotes('top', notes.path)).granted, false);
  assert.ok(f.records.get('top').meta.config.additionalDirectories.includes(notes.path));
  f.orch.journal.change((d: any) => {
    d.children.child = {
      parentId: 'top',
      name: 'child',
      title: 'Child',
      createdAt: 1,
      driven: [],
      lastReport: null,
      detached: true,
      awaitingBrief: true,
    };
  });
  const snapshot = await f.handlers.get('orchestration:snapshot')({ sender: 'app' });
  assert.equal(snapshot.children.child.detached, true);
  assert.equal(snapshot.children.child.awaitingBrief, true);
  f.records.set('child', { meta: { archived: 1 } });
  await assert.rejects(
    f.controller.beforeDispatch({
      chatId: 'child',
      kind: 'turn',
      item: { id: 'input', text: 'hi', opts: { human: true } },
      ref: f.controller.ref('child'),
    }),
    /Restore it/,
  );
  f.controller.onLiveEvent('codex', { kind: 'irrelevant' });
  f.controller.onLiveEvent('claude', { kind: 'irrelevant' });
  f.records.get('top').meta.archived = 1;
  await f.orch.o.cleanupNotes('top', () => true);
  assert.equal(fs.existsSync(notes.path), false);
});

test('trusted archive and detach IPC use the main lifecycle; arbitrary windows cannot choose a family', async (t) => {
  const f = fixture(t);
  f.records.set('child', { meta: {} });
  f.orch.journal.change(
    (d: any) => (d.children.child = { parentId: 'top', name: 'child', title: 'Child', createdAt: 1, driven: [], lastReport: null }),
  );
  assert.equal((await f.handlers.get('orchestration:child')({ sender: 'app' }, 'child', 'detach')).detached, true);
  assert.throws(() => f.handlers.get('orchestration:archiveFamily')({ sender: 'guest' }, 'top', 'parent'), /Unknown app window/);
  f.live.archiveChat = (id: string) => {
    f.records.get(id).meta.archived = 1;
    return true;
  };
  assert.deepEqual((await f.handlers.get('orchestration:archiveFamily')({ sender: 'app' }, 'top', 'parent', [])).archived, ['top']);
});

test('archive dispatch guards include roots while leaving unrelated session policy with its own owner', async (t) => {
  const f = fixture(t);
  f.records.get('top').meta.archived = 1;
  f.orch.journal.change((d: any) => (d.parents.top = { wakes: 0, notes: [], held: false, cutShort: false }));
  await assert.rejects(
    f.controller.beforeDispatch({
      chatId: 'top',
      kind: 'turn',
      item: { id: 'input', opts: { human: true } },
      ref: f.controller.ref('top'),
    }),
    /Restore it/,
  );
  f.records.set('unrelated', { meta: { archived: 1 } });
  await assert.doesNotReject(
    f.controller.beforeDispatch({
      chatId: 'unrelated',
      kind: 'turn',
      item: { id: 'u', opts: { human: true } },
      ref: f.controller.ref('unrelated'),
    }),
  );
});

test('empty offer snapshots use real default placement and expose roots even when no child survived a failed start', () => {
  const data = {
    children: { c: { parentId: 'p', name: 'c', title: 'C', detached: true, awaitingBrief: true } },
    parents: { p: {} },
    deliveries: {},
    proposals: { offer: { parentId: 'p', kind: 'offer', args: { title: 'Task', prompt: null }, status: 'open', expiresAt: 9 } },
  };
  const folder = orchestrationView(data, 1, () => false);
  assert.equal(folder.proposals.offer.prompt, '');
  assert.equal(folder.proposals.offer.place, 'folder');
  assert.deepEqual(folder.families, ['p']);
  assert.equal(orchestrationView(data, 1, () => true).proposals.offer.place, 'worktree');
  assert.equal(orchestrationView(data).proposals.offer.place, 'worktree');
});

test('verified plan acceptance survives the actual app hooks attaching a new or changed family roster', async (t) => {
  const f = fixture(t);
  const { preparePlanInput, suggestionLimit } = require('../electron/session/orchestration/planAcceptance.cjs');
  f.controller.state.localWriterToken = () => null;
  f.live.peerRuntime.readHistory = async () => ({
    turns: [{ status: 'completed', items: [{ type: 'plan', id: 'p1', text: 'Independent tasks' }] }],
  });
  f.records.set('child', { meta: {} });
  f.orch.journal.change(
    (d: any) => (d.children.child = { parentId: 'top', name: 'child', title: 'Child', createdAt: 1, driven: [], lastReport: null }),
  );
  for (const changed of [false, true]) {
    f.states.set('top', { turn: 'idle' });
    const item = await preparePlanInput(
      f.live,
      'top',
      {
        id: changed ? 'next' : 'implement',
        text: 'Implement the plan.',
        opts: { human: true, plan: false, acceptedPlan: { itemId: 'p1', text: 'Independent tasks' } },
      },
      () => true,
    );
    if (changed) f.states.set('child', { turn: 'running' });
    f.userTurn();
    await f.controller.beforeDispatch({ chatId: 'top', kind: 'turn', item, ref: f.controller.ref('top') });
    assert.match(item.text, /sage-linked-sessions/);
    assert.equal(suggestionLimit(f.orch, 'top'), 4);
  }
});

test('a legacy projection without parent bookkeeping does not invent family cleanup ownership', () => {
  const view = orchestrationView({ children: {}, deliveries: {} });
  assert.equal(view.families, undefined);
  assert.deepEqual(view.children, {});
});

test("the Remote Control tool is registered with the chat tools and reaches the calling chat's Claude session", async (t) => {
  const { Registry } = require('../electron/capabilities/contract/registry.cjs');
  const registry = new Registry();
  registry.setApprover(async () => true);
  const asked: unknown[][] = [];
  const view = { state: 'on', url: 'https://claude.ai/code/session_a', error: null, wanted: true };
  const f = fixture(t, {
    capabilities: registry,
    claudeTurns: { api: { control: async (...a: unknown[]) => (asked.push(a), view) } },
  });
  f.controller.ref = (id: string) => ({ kind: 'claude', key: `claude:${id}` });
  const named = registry.list().map((x: any) => x.name);
  assert.ok(named.includes('set_remote_control'));
  const res = await registry.invoke('cl', 'seg', 'set_remote_control', { enabled: true });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(asked, [['claude:cl', 'remoteControl', { on: true }]]);
});

test('a chat counts as driven from claude.ai while its link is up or waiting for the network, and not otherwise', (t) => {
  const f = fixture(t);
  const states: Record<string, any> = {
    up: { remoteControl: { state: 'on' } },
    away: { remoteControl: { state: 'offline' } },
    signin: { remoteControl: { state: 'signin' } },
    off: { remoteControl: { state: 'off' } },
    none: { remoteControl: null },
  };
  f.controller.state.get = (id: string) => states[id];
  const driven = (id: string) => f.orch.o.remotelyDriven(id);
  assert.deepEqual(['up', 'away', 'signin', 'off', 'none', 'unknown'].map(driven), [true, true, false, false, false, false]);
});

test('the app hands the orchestrator the controller deliverFamily, so a message to a running child can steer in', async (t) => {
  const f = fixture(t);
  const seen: any[] = [];
  f.controller.deliverFamily = async (chatId: string, item: any) => (seen.push([chatId, item.id]), { started: true, steered: true });
  assert.deepEqual(await f.orch.o.deliverFamily('child', { id: 'm1' }), { started: true, steered: true });
  assert.deepEqual(seen, [['child', 'm1']]);
});

test("an offer's call is let go by the user's queued message, a Stop, a crash or its turn's end, through the controller", async (t) => {
  const { OPEN_NEXT, QUEUED_NEXT } = require('../electron/session/orchestration/proposals.cjs');
  const f = fixture(t);
  f.userTurn();
  const offer = (title: string) => f.orch.start('top', { title, initiation: 'offer' });
  const waiting = () => Object.values<any>(f.orch.journal.data.proposals).filter((p) => p.waiting).length;
  // the user's message queued behind the turn: the offer is closed, and the agent ends its turn so it runs next
  const queued = offer('Queued');
  f.controller.onQueued('top', { text: 'note', opts: {}, peer: { from: 'other' } });
  assert.equal(waiting(), 1, 'a peer note is not the user’s word');
  f.controller.onQueued('top', { text: 'wait, do X first', opts: { human: true } });
  assert.deepEqual([(await queued).answer, (await queued).next], ['superseded', QUEUED_NEXT]);
  // a Stop, a harness that quit, or the turn's end: the call is let go and the card stays open, counting no more
  for (const [title, end] of [
    ['Stopped', () => f.controller.onStopped('top')],
    ['Crashed', () => f.controller.onCrash('top')],
    ['Ended', () => f.controller.onFinished({ chatId: 'top', completed: false })],
  ] as const) {
    const call = offer(title);
    assert.equal(waiting(), 1);
    end();
    const r = await call;
    assert.deepEqual([r.still_open, r.next], [true, OPEN_NEXT]);
    const p = Object.values<any>(f.orch.journal.data.proposals).find((x) => x.args.title === title);
    assert.deepEqual([p.status, p.waiting, p.countdown], ['open', undefined, undefined]);
  }
  // another chat's end lets go of nothing here
  const other = offer('Other');
  f.controller.onStopped('elsewhere');
  assert.equal(waiting(), 1);
  f.controller.onQueued('top', { text: 'never mind', opts: { human: true } });
  assert.equal((await other).answer, 'superseded');
});
