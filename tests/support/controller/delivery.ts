// Queued delivery receipts, retries and cancelled-start ownership scenarios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { assertInputCurrent } = createRequire(import.meta.url)('../../../electron/session/contract/inputGuard.cjs');
import { setup, tick } from './fixture';

export function registerDeliveryCases() {
  test('queued send receipts wait for actual acceptance on every harness and retain failures', async () => {
    for (const family of ['codex', 'claude', 'acp:kimi']) {
      const { c, chats, state, execs, s } = setup({ auto: false });
      const chat = `receipt-${family}`;
      chats.records.set(chat, { id: chat, segments: [{ kind: family, nativeId: 'native' }] });
      state.patch(chat, { turn: 'running', activeTurn: { id: 'live' } });
      const q = c.send(chat, { text: 'follow-up', attachments: [{ kind: 'file', path: '/file' }], opts: { human: true } }, 2);
      let settled = false;
      const receipt = Promise.resolve(c.sendNow(chat, q.id, 2, true)).then((r) => {
        settled = true;
        return r;
      });
      await tick();
      if (family === 'acp:kimi') {
        assert.deepEqual(await receipt, { status: 'queued' });
        assert.equal(execs.length, 0);
        assert.equal(s(chat).queue[0].id, q.id);
        c.end(chat);
        await tick();
        assert.equal(execs[0].kind, 'acp-turn');
        execs[0].done({ started: true });
        await tick();
      } else {
        assert.equal(settled, false);
        assert.equal(execs[0].item.attachments[0].path, '/file');
        execs[0].done({ started: false, error: 'connection lost' });
        assert.deepEqual(await receipt, { status: 'queued', error: 'connection lost' });
        assert.equal(s(chat).queue[0].id, q.id);
        const retry = c.sendNow(chat, q.id, 2, true);
        await tick();
        execs[1].done({ started: true });
        assert.deepEqual(await retry, { status: 'sent' });
        assert.equal(s(chat).queue.length, 0);
      }
    }
  });

  test('queued receipts retain refused idle turns and report missing queue entries', async () => {
    const { c, state, execs, s } = setup({ auto: false });
    state.patch('t1', { queue: [{ id: 'q', text: 'kept', attachments: [], opts: {}, origin: 1 }] });
    assert.deepEqual(c.sendNow('t1', 'missing', 1, true), { status: 'missing' });
    const receipt = c.sendNow('t1', 'q', 1, true);
    await tick();
    execs[0].done({ started: false });
    assert.deepEqual(await receipt, { status: 'queued', error: 'The harness did not accept the message.' });
    assert.deepEqual(
      s('t1').queue.map((q: any) => q.id),
      ['q'],
    );
    const retry = c.sendNow('t1', 'q', 1, true);
    await tick();
    execs[1].done({ started: true, turnId: 'turn' });
    assert.deepEqual(await retry, { status: 'sent' });
  });

  test('queued receipts follow a refused steer into its next turn without dropping or duplicating it', async () => {
    for (const accepted of [true, false]) {
      const { c, state, execs, s } = setup({ auto: false });
      state.patch('t1', { turn: 'running', activeTurn: { id: 'live' } });
      const q = c.send('t1', { text: 'next' }, 1);
      const receipt = c.sendNow('t1', q.id, 1, true);
      await tick();
      c.end('t1');
      execs[0].done({ started: false, error: 'turn ended' });
      await tick();
      assert.equal(execs[1].kind, 'turn');
      execs[1].done({ started: accepted, error: accepted ? undefined : 'start refused' });
      assert.deepEqual(await receipt, accepted ? { status: 'sent' } : { status: 'queued', error: 'start refused' });
      assert.equal(s('t1').queue.filter((item: any) => item.id === q.id).length, accepted ? 0 : 1);
    }
  });

  test('queued retries preserve handoff context after the new harness refuses the first turn', async () => {
    for (const steering of [false, true]) {
      const { c, state, execs, s } = setup({ auto: false });
      const q = { id: 'handoff-q', text: 'continue', attachments: [{ kind: 'file', path: '/file' }], opts: { human: true }, origin: 1 };
      state.patch('t1', { queue: [q], ...(steering ? { turn: 'running', activeTurn: { id: 'live' } } : {}) });
      state.clientPatch('t1', { pendingSwitch: { harness: 'claude', model: 'm', modelLabel: 'M', mode: 'auto' } });
      const receipt = c.sendNow('t1', q.id, 1, true);
      let offset = 0;
      if (steering) {
        await tick();
        c.end('t1');
        execs[0].done({ started: false, error: 'turn ended' });
        offset = 1;
      }
      await tick();
      assert.equal(execs[offset].kind, 'handoff');
      const note = { kind: 'switch', text: 'prepared handoff' };
      execs[offset].done({ ready: true, prefix: '<prepared-context/>', note });
      await tick();
      execs[offset + 1].done({ started: false, error: 'refused' });
      assert.deepEqual(await receipt, { status: 'queued', error: 'refused' });
      assert.deepEqual(s('t1').queue[0].opts, { human: true, prefix: '<prepared-context/>', note });
      assert.deepEqual(s('t1').queue[0].attachments, q.attachments);
      const retry = c.sendNow('t1', q.id, 1, true);
      await tick();
      assert.equal(execs[offset + 2].kind, 'turn');
      assert.deepEqual(execs[offset + 2].item.opts, { human: true, prefix: '<prepared-context/>', note });
      execs[offset + 2].done({ started: true });
      assert.deepEqual(await retry, { status: 'sent' });
    }
  });

  test('queued sends cancelled during switch preparation retain the original message once', async () => {
    for (const steering of [false, true]) {
      const { c, state, execs, s } = setup({ auto: false });
      const q = { id: 'cancelled-q', text: 'continue', attachments: [], opts: { human: true }, origin: 1 };
      state.patch('t1', { queue: [q], ...(steering ? { turn: 'running', activeTurn: { id: 'live' } } : {}) });
      state.clientPatch('t1', { pendingSwitch: { harness: 'claude', model: 'm', modelLabel: 'M', mode: 'auto' } });
      const receipt = c.sendNow('t1', q.id, 1, true);
      let offset = 0;
      if (steering) {
        await tick();
        c.end('t1');
        execs[0].done({ started: false });
        offset = 1;
      }
      await tick();
      assert.equal(execs[offset].kind, 'handoff');
      c.end('t1', { drain: false });
      execs[offset].done({ ready: true });
      assert.deepEqual(await receipt, { status: 'queued', error: 'turn_changed' });
      assert.doesNotThrow(() => assertInputCurrent(s('t1').queue[0]), 'retained input no longer carries the retired dispatch check');
      assert.deepEqual(structuredClone(s('t1').queue), [q]);
      assert.equal(execs.length, offset + 1);
    }
  });

  test('automatic queue draining retains a refused message before later messages on every harness', async () => {
    for (const family of ['codex', 'claude', 'acp:kimi']) {
      const { c, state, chats, execs, s } = setup({ auto: false });
      const chat = `drain-${family}`;
      chats.records.set(chat, { id: chat, segments: [{ kind: family, nativeId: 'native' }] });
      state.patch(chat, { turn: 'running', activeTurn: { id: 'live' } });
      const first = c.send(chat, { text: 'first', attachments: [{ kind: 'file', path: '/attached' }], opts: { human: true } }, 1);
      const second = c.send(chat, { text: 'second', opts: { human: true } }, 1);
      const original = s(chat).queue[0];
      const later = s(chat).queue[1];
      c.end(chat);
      await tick();
      assert.equal(execs[0].kind, family === 'codex' ? 'turn' : family === 'claude' ? 'claude-turn' : 'acp-turn');
      execs[0].done({ started: false, error: 'connection unavailable' });
      await tick();
      assert.deepEqual(s(chat).queue, [original, later]);
      assert.deepEqual(
        s(chat).queue.map((q: any) => q.id),
        [first.id, second.id],
      );
      assert.equal(s(chat).turn, 'crashed');
      assert.ok(s(chat).crashed, 'a refused initial send stays visibly failed');
      await tick();
      assert.equal(execs.length, 1, 'refusal must not automatically retry or skip to later messages');
      const retry = c.sendNow(chat, first.id, 1, true);
      await tick();
      assert.deepEqual(execs[1].item, original);
      execs[1].done({ started: true });
      assert.deepEqual(await retry, { status: 'sent' });
      c.end(chat);
      await tick();
      assert.equal(execs[2].item.id, second.id);
      execs[2].done({ started: true });
      await tick();
      assert.equal(s(chat).queue.length, 0);
    }
  });

  test('a drained message preserves prepared handoff metadata when its new turn is refused', async () => {
    const { c, state, execs, s } = setup({ auto: false });
    const q = { id: 'drained-handoff', text: 'continue', attachments: [], opts: { human: true }, origin: 1 };
    state.patch('t1', { queue: [q] });
    state.clientPatch('t1', { pendingSwitch: { harness: 'claude', model: 'm', modelLabel: 'M', mode: 'auto' } });
    const draining = c.drain('t1');
    const note = { kind: 'switch', text: 'prepared' };
    execs[0].done({ ready: true, prefix: '<handoff-context/>', note, after: [{ text: '/goal continue', opts: { goal: 'continue' } }] });
    await tick();
    execs[1].done({ started: false });
    await draining;
    assert.equal(s('t1').queue[0].id, q.id);
    assert.deepEqual(s('t1').queue[0].opts, { human: true, prefix: '<handoff-context/>', note });
    assert.equal(s('t1').queue[1].text, '/goal continue');
    assert.equal(execs.length, 2);
  });

  test('cancelling switch preparation during drain keeps its queued message once', async () => {
    const { c, state, execs, s } = setup({ auto: false });
    const q = { id: 'cancelled-drain', text: 'keep', attachments: [], opts: {}, origin: 1 };
    state.patch('t1', { queue: [q] });
    state.clientPatch('t1', { pendingSwitch: { harness: 'claude', model: 'm', modelLabel: 'M', mode: 'auto' } });
    const draining = c.drain('t1');
    c.end('t1', { drain: false });
    execs[0].done({ ready: true });
    await draining;
    assert.doesNotThrow(() => assertInputCurrent(s('t1').queue[0]), 'retained input no longer carries the retired dispatch check');
    assert.deepEqual(structuredClone(s('t1').queue), [q]);
    assert.equal(execs.length, 1);
  });

  test('initial sends refused by any harness retain the full message for retry ahead of follow-ups', async () => {
    for (const family of ['codex', 'claude', 'acp:kimi']) {
      const { c, chats, execs, s } = setup({ auto: false });
      const chat = `initial-${family}`;
      chats.records.set(chat, { id: chat, segments: [{ kind: family, nativeId: 'native' }] });
      const result = c.send(chat, { text: 'keep initial', attachments: [{ kind: 'file', path: '/attached' }], opts: { human: true } }, 7);
      assert.equal(result.action, 'started');
      const original = execs[0].item;
      const follow = c.send(chat, { text: 'later', opts: { human: true } }, 7);
      execs[0].done({ started: false, error: 'cannot start' });
      await tick();
      assert.deepEqual(
        s(chat).queue.map((q: any) => q.id),
        [result.id, follow.id],
      );
      assert.deepEqual(s(chat).queue[0], original);
      assert.equal(s(chat).turn, 'crashed');
      assert.ok(s(chat).crashed, 'a refused initial send stays visibly failed');
      assert.equal(execs.length, 1);
      const retry = c.sendNow(chat, result.id, 7, true);
      await tick();
      assert.deepEqual(execs[1].item, original);
      execs[1].done({ started: true });
      assert.deepEqual(await retry, { status: 'sent' });
      assert.deepEqual(
        s(chat).queue.map((q: any) => q.id),
        [follow.id],
      );
    }
  });

  test('refused initial handoffs keep prepared context and cancellation retains the original input', async () => {
    for (const cancelled of [false, true]) {
      const { c, state, execs, s } = setup({ auto: false });
      state.clientPatch('t1', { pendingSwitch: { harness: 'claude', model: 'm', modelLabel: 'M', mode: 'auto' } });
      const sent = c.send('t1', { text: 'continue', opts: { human: true } }, 1);
      if (cancelled) c.end('t1', { drain: false });
      const note = { kind: 'switch', text: 'prepared' };
      execs[0].done({ ready: true, ...(cancelled ? {} : { prefix: '<handoff/>', note }) });
      await tick();
      if (!cancelled) {
        execs[1].done({ started: false });
        await tick();
      }
      assert.equal(s('t1').queue.length, 1);
      assert.equal(s('t1').queue[0].id, sent.id);
      assert.deepEqual(s('t1').queue[0].opts, cancelled ? { human: true } : { human: true, prefix: '<handoff/>', note });
    }
  });

  test('a completed handoff after Stop retains prepared context for the queued retry on the new harness', async () => {
    for (const from of ['codex', 'claude']) {
      for (const mode of ['initial', 'manual', 'drain', 'steer']) {
        const { c, state, chats, execs, s } = setup({ auto: false });
        const chat = `cancel-handoff-${from}-${mode}`;
        const to = from === 'codex' ? 'claude' : 'codex';
        chats.records.set(chat, { id: chat, segments: [{ kind: from, nativeId: 'old-native' }] });
        const pendingSwitch = { harness: to, model: 'm', modelLabel: 'M', mode: 'auto', goal: 'continue goal' };
        let id: string;
        let offset = 0;
        if (mode === 'initial') {
          state.clientPatch(chat, { pendingSwitch });
          id = c.send(chat, { text: 'continue', attachments: [{ kind: 'file', path: '/attached' }], opts: { human: true } }, 1).id;
        } else {
          const q = {
            id: 'retry-input',
            text: 'continue',
            attachments: [{ kind: 'file', path: '/attached' }],
            opts: { human: true },
            origin: 1,
          };
          state.patch(chat, { queue: [q], ...(mode === 'steer' ? { turn: 'running', activeTurn: { id: 'live' } } : {}) });
          id = q.id;
          if (mode === 'steer') {
            c.sendNow(chat, id, 1, true);
            await tick();
            state.clientPatch(chat, { pendingSwitch });
            c.end(chat);
            execs[0].done({ started: false });
            offset = 1;
            await tick();
          } else {
            state.clientPatch(chat, { pendingSwitch });
            if (mode === 'manual') c.sendNow(chat, id, 1, true);
            else c.drain(chat);
          }
        }
        assert.equal(execs[offset].kind, 'handoff');
        c.end(chat, { drain: false });
        chats.setSegments(chat, [{ harness: to, nativeId: to === 'claude' ? 'claude:new-native' : 'new-native', start: 0, count: null }]);
        const note = { kind: 'switch', text: `${from} to ${to}` };
        execs[offset].done({
          ready: true,
          prefix: '<prepared-context/>',
          note,
          after: [{ text: '/goal continue goal', opts: { goal: 'continue goal' } }],
        });
        await tick();
        assert.equal(execs.length, offset + 1, 'Stop must prevent native dispatch');
        assert.equal(s(chat).queue.length, 1, 'Stop must not restart follow-on goals');
        assert.equal(s(chat).queue[0].id, id);
        assert.deepEqual(s(chat).queue[0].opts, { human: true, prefix: '<prepared-context/>', note });
        assert.deepEqual(s(chat).queue[0].attachments, [{ kind: 'file', path: '/attached' }]);
        const retry = c.sendNow(chat, id, 1, true);
        await tick();
        assert.equal(execs[offset + 1].kind, to === 'claude' ? 'claude-turn' : 'turn');
        assert.equal(execs[offset + 1].item.opts.prefix, '<prepared-context/>');
        execs[offset + 1].done({ started: true });
        assert.deepEqual(await retry, { status: 'sent' });
      }
    }
  });

  test('a cancelled start receipt cannot end a new attempt using the same peer message id', async () => {
    for (const family of ['codex', 'claude', 'acp:kimi']) {
      const { c, state, chats, execs, s } = setup({ auto: false });
      const chat = `attempt-${family}`;
      chats.records.set(chat, { id: chat, segments: [{ kind: family, nativeId: 'native' }] });
      let release!: () => void;
      const receipt = new Promise<void>((resolve) => {
        release = resolve;
      });
      c.onDispatchResult = ({ result }: any) => (result.started ? undefined : receipt);
      state.clientPatch(chat, { pendingSwitch: { harness: 'claude', mode: 'auto' } });
      const input = { id: 'same-peer-message', text: 'retry', opts: {}, peer: { messageId: 'same-peer-message', sourceChatId: 'source' } };
      c.send(chat, input, 1);
      c.end(chat, { drain: false });
      execs[0].done({ ready: true });
      await tick();
      c.send(chat, input, 1);
      assert.equal(s(chat).turn, 'running');
      await tick();
      release();
      await tick();
      assert.equal(s(chat).turn, 'running', 'the old cancellation must not end the new pending turn');
      execs[1].done({ started: true, turnId: 'new-attempt' });
      await tick();
      assert.equal(s(chat).turn, 'running');
      assert.equal(s(chat).activeTurn.id, 'new-attempt');
      assert.equal(c.rt(chat).inputToken, 'pending-same-peer-message', 'peer receipt identity remains stable');
      c.end(chat, { drain: false });
    }
  });

  test('preflight from a cancelled start cannot submit into a new attempt with the same input token', async () => {
    for (const family of ['codex', 'claude', 'acp:kimi']) {
      const { c, chats, execs, s } = setup({ auto: false });
      const chat = `preflight-${family}`;
      chats.records.set(chat, { id: chat, segments: [{ kind: family, nativeId: 'native' }] });
      let release!: () => void;
      let checks = 0;
      c.beforeDispatch = () =>
        ++checks === 1
          ? new Promise<void>((resolve) => {
              release = resolve;
            })
          : undefined;
      const item = {
        id: 'same-peer-input',
        text: 'Peer request',
        attachments: [],
        opts: { human: false },
        peer: { messageId: 'same-peer-input' },
      };
      const old = c.start(chat, item);
      c.end(chat, { drain: false });
      const retry = c.start(chat, item);
      await tick();
      assert.equal(execs.length, 1);
      release();
      const cancelled = await old;
      assert.equal(cancelled.started, false);
      assert.equal(cancelled.error, 'turn_changed');
      assert.equal(execs.length, 1, 'the cancelled attempt must never reach the native harness');
      assert.equal(s(chat).activeTurn.id, 'pending-same-peer-input');
      execs[0].done({ started: true, turnId: 'retry-turn' });
      assert.equal((await retry).started, true);
      assert.equal(s(chat).activeTurn.id, 'retry-turn');
      c.end(chat);
    }
  });

  test('a delayed ordinary steer stays queued when another turn replaced its original turn', async () => {
    for (const [chat, kind] of [
      ['t1', 'turn'],
      ['claude:s1', 'claude-turn'],
    ]) {
      const { c, execs, s } = setup({ auto: false });
      c.send(chat, { text: 'Original', opts: { human: true } }, 1);
      execs[0].done({ started: true, turnId: 'original-turn' });
      await tick();
      const queued = c.send(chat, { text: 'Delayed steer', opts: { human: true } }, 1);
      let release!: () => void;
      c.beforeDispatch = ({ kind }: any) =>
        kind === 'steer'
          ? new Promise<void>((resolve) => {
              release = resolve;
            })
          : undefined;
      const delivery = c.sendNow(chat, queued.id, 1, true);
      c.end(chat, { drain: false });
      c.send(chat, { text: 'Replacement', opts: { human: true } }, 1);
      await tick();
      release();
      await tick();
      assert.equal(execs.length, 2, 'the old steer must not reach the adapter for the replacement turn');
      assert.deepEqual(await delivery, { status: 'queued', error: 'turn_changed' });
      assert.deepEqual(
        s(chat).queue.map((q: any) => q.id),
        [queued.id],
      );
      execs[1].done({ started: true, turnId: 'replacement-turn' });
      await tick();
      c.end(chat);
      await tick();
      assert.equal(execs.length, 3);
      assert.equal(execs[2].kind, kind);
      assert.equal(execs[2].item.id, queued.id);
      execs[2].done({ started: true });
      await tick();
      assert.equal(s(chat).queue.length, 0);
      c.end(chat, { drain: false });
    }
  });

  test('controller notification bodies retain Unicode at the existing length boundary', () => {
    const seen: any[] = [];
    const { c } = setup({ notify: (...args: any[]) => seen.push(args) });
    for (const kind of ['turn', 'approval', 'goal']) {
      for (const [body, expected] of [
        ['x'.repeat(179) + '🙂tail', 'x'.repeat(179)],
        ['x'.repeat(178) + '🙂tail', 'x'.repeat(178) + '🙂'],
        ['x'.repeat(181), 'x'.repeat(180)],
      ]) {
        c.say(kind, 'named', { body });
        assert.equal(seen.at(-1)[2].body, expected);
        assert.equal(seen.at(-1)[2].body.isWellFormed(), true);
      }
    }
  });
}
