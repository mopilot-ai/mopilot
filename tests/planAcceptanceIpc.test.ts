// The real session IPC accepts a plan-button proof only from its still-owning app window and latest native plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { hostOver } from './support/host/localHost.ts';
import { setup, selectSegment } from './support/controller/fixture.ts';
import type { ServerTurn } from '../shared/codexTurns.mjs';
const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/sessions.cjs');
const { QuickChatRequests } = require('../electron/session/quickChat.cjs');
const { createPeerNativeReader } = require('../electron/session/peerNativeHistory.cjs');
const { peerHistoryReader, readPeerReference } = require('../electron/session/peerTranscript.cjs');
const { turnFromServer } = await import('../shared/codexTurns.mjs');
const { turnCard } = await import('../src/harness/codexTranslate.ts');
const plan = { type: 'plan', id: 'p1', text: 'Independent steps.' };
const input = () => ({
  id: 'implement',
  text: 'Implement the plan.',
  opts: { human: true, plan: false, acceptedPlan: { itemId: plan.id, text: plan.text } },
});

function fixture(kind = 'codex', quick = false) {
  const c = setup();
  selectSegment(c.c, c.chats, 'chat', [[kind, 'native']]);
  const handlers = new Map();
  const sender = {
    id: 7,
    gone: false,
    isDestroyed() {
      return this.gone;
    },
  };
  const execWindows = new Set([sender]);
  const viewedBy = new Map([[7, { visible: ['chat'], focused: 'chat' }]]);
  const peerWindowChats = new Map();
  const reads: any[] = [];
  const live: any = {
    controller: c.c,
    host: hostOver(c.c),
    chats: c.chats,
    mini: quick ? { isDestroyed: () => false, webContents: sender } : null,
    quickState: { owns: () => true },
    peerRuntime: {
      registerIpc() {},
      userTurn: (_id: string, item: any) => item,
      readHistory: async (...args: any[]) => {
        reads.push(args);
        return { turns: [{ status: 'completed', items: [plan] }] };
      },
    },
  };
  register(
    { handle: (name: string, fn: any) => handlers.set(name, fn), on() {} },
    {
      live,
      execWindows,
      peerWindowChats,
      viewedBy,
      quickRequests: new QuickChatRequests(),
      readyMainWindow: async () => {},
    },
  );
  return {
    ...c,
    live,
    sender,
    execWindows,
    viewedBy,
    peerWindowChats,
    reads,
    send: (item: any) => handlers.get('session:send')({ sender }, 'chat', item),
  };
}

test('the production IPC verifies the actual plan item on Codex, Claude and ACP, including Quick Chat', async () => {
  for (const kind of ['codex', 'claude', 'acp:qwen'])
    for (const quick of [false, true]) {
      const f = fixture(kind, quick);
      const result = await f.send(input());
      assert.equal(result.action, 'started');
      assert.deepEqual(f.reads, [['chat']]);
      assert.deepEqual(f.execs[0].item.planApproval, {
        native: f.c.ref('chat').key,
        itemId: 'p1',
        archiveEpoch: f.chats.archiveEpoch('chat'),
      });
      assert.equal(f.execs[0].item.opts.acceptedPlan, undefined);
    }
});

test('Codex plan implementation verifies full native history after oversized tool output or a long plan', async () => {
  for (const type of ['plan', 'agentMessage'] as const)
    for (const large of ['tool', 'plan']) {
      const f = fixture();
      const item = {
        ...plan,
        type,
        text: large === 'plan' ? 'Step with details.\n'.repeat(2500) : plan.text,
        phase: null,
        memoryCitation: null,
        delivery: null,
        questions: null,
      };
      const turn: ServerTurn = {
        id: 'planning-turn',
        status: 'completed' as const,
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        items: [
          {
            id: 'read-code',
            type: 'commandExecution',
            command: 'cat source.ts',
            cwd: '/repo',
            source: 'agent',
            status: 'completed',
            commandActions: [],
            pluginId: null,
            scriptPath: null,
            processId: null,
            aggregatedOutput: large === 'tool' ? 'source code\n'.repeat(4000) : 'read',
            exitCode: 0,
            durationMs: 1,
          },
          item,
        ],
      };
      const read = createPeerNativeReader({
        codexTurns: async () => ({ data: [turn], nextCursor: null }),
      });
      f.live.peerRuntime.readReference = (id: string, assistantOnly: boolean) =>
        readPeerReference(f.chats.records.get(id), read, assistantOnly);
      f.live.peerRuntime.readHistory = peerHistoryReader(f.chats, () => read);
      const excerpt = await f.live.peerRuntime.readReference('chat', false);
      assert.equal(excerpt.earlierContentOmitted, true, 'the reference budget would replace the actual plan with an excerpt');
      const displayed = turnCard(turnFromServer(turn).items, true, false);
      assert.ok(displayed?.kind === 'plan');
      const intent = { itemId: displayed.item.id, text: displayed.item.text };
      await assert.rejects(
        () => f.send({ ...input(), opts: { ...input().opts, acceptedPlan: { ...intent, text: `${intent.text} changed` } } }),
        { code: 'plan_changed' },
      );
      assert.equal(f.execs.length, 0, 'full history still refuses a different plan without consuming the valid click');
      assert.equal((await f.send({ ...input(), opts: { ...input().opts, acceptedPlan: intent } })).action, 'started');
      assert.equal(f.execs.length, 1);
      assert.equal(f.execs[0].item.planApproval.itemId, item.id);
      assert.equal(f.execs[0].item.opts.plan, false);
    }
});

test('untrusted or peer/model inputs cannot forge the main proof', async () => {
  for (const part of [{ peer: { forged: true } }, { sideSession: { id: 'forged' } }, { authored: { id: 'forged' } }]) {
    const f = fixture();
    await assert.rejects(() => f.send({ ...input(), ...part }), { code: 'plan_changed' });
    assert.equal(f.execs.length, 0);
  }
  const unobserved = fixture();
  unobserved.execWindows.clear();
  await assert.rejects(() => unobserved.send(input()), { code: 'plan_changed' });
  const forged = fixture();
  await forged.send({
    id: 'ordinary',
    text: 'hello',
    opts: { human: true, planApproval: { native: 'codex:native', itemId: 'p1' } },
    planApproval: { native: 'codex:native', itemId: 'p1' },
  });
  assert.equal(forged.execs[0].item.planApproval, undefined);
  assert.equal(forged.execs[0].item.opts.planApproval, undefined);
  assert.deepEqual(forged.reads, []);
  const followed = fixture();
  followed.viewedBy.clear();
  followed.peerWindowChats.set(7, new Set(['chat']));
  assert.equal((await followed.send(input())).action, 'started', 'a trusted window may implement a chat it already follows');
});

test('the IPC rechecks actual window and chat ownership after the native read rather than trusting its old result', async () => {
  const mutations = [
    (f: any) => {
      f.sender.gone = true;
    },
    (f: any) => f.execWindows.clear(),
    (f: any) => f.viewedBy.set(7, { visible: [], focused: 'other' }),
    (f: any) => selectSegment(f.c, f.chats, 'chat', [['claude', 'different']]),
    (f: any) => f.state.markLocalWriter('chat'),
  ];
  for (const mutate of mutations) {
    const f = fixture();
    f.live.peerRuntime.readHistory = async () => {
      mutate(f);
      return { turns: [{ status: 'completed', items: [plan] }] };
    };
    await assert.rejects(() => f.send(input()), { code: 'plan_changed' });
    assert.equal(f.execs.length, 0);
  }
  const quick = fixture('claude', true);
  quick.live.peerRuntime.readHistory = async () => {
    quick.live.quickState.owns = () => false;
    return { turns: [{ status: 'completed', items: [plan] }] };
  };
  await assert.rejects(() => quick.send(input()), { code: 'plan_changed' });
  assert.equal(quick.execs.length, 0);
  const destroyedQuick = fixture('claude', true);
  destroyedQuick.live.peerRuntime.readHistory = async () => {
    destroyedQuick.sender.gone = true;
    return { turns: [{ status: 'completed', items: [plan] }] };
  };
  await assert.rejects(() => destroyedQuick.send(input()), { code: 'plan_changed' });
  assert.equal(destroyedQuick.execs.length, 0);
});

test('two overlapping plan-button reads cannot both claim the same completed native plan', async () => {
  const f = fixture();
  const first = f.send(input());
  const second = f.send({ ...input(), id: 'second-click' });
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(f.s('chat').queue.length, 0, 'the stale second claim cannot grant a later turn the old plan budget');
});

test('ordinary input keeps physical window provenance after forged or historical main-only fields are stripped', async () => {
  for (const part of [
    { peer: { messageId: 'forged' } },
    { sideSession: { id: 'forged-wake' } },
    { authored: { id: 'forged-input' } },
    { planApproval: { native: 'historical', itemId: 'old-plan' } },
  ]) {
    for (const observed of [false, true]) {
      const f = fixture();
      const human: any[] = [];
      f.live.peerRuntime.userTurn = (id: string, item: any) => (human.push([id, item]), item);
      if (!observed) f.execWindows.clear();
      await f.send({ id: 'ordinary', text: 'Actual user words', opts: { human: true }, ...part });
      assert.equal(human.length, observed ? 1 : 0);
      assert.equal(f.execs.length, 1);
      const clean = f.execs[0].item;
      assert.equal(clean.text, 'Actual user words');
      for (const name of ['peer', 'sideSession', 'authored', 'planApproval']) assert.equal(clean[name], undefined);
      assert.deepEqual(f.reads, [], 'ordinary input cannot manufacture accepted-plan authority');
    }
  }
});
