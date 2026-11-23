// Main's ACP translators (electron/harness/items/acp.cjs) follow the stable chat that owns a session: updates before a
// segment commits stay out of it, and a translator whose owner changed can't finish a turn of the new owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { AcpItems, STRAY_MS } = createRequire(import.meta.url)('../electron/harness/items/acp.cjs');

const chunk = (key: string, turnId: string | null, text: string) => ({
  key,
  kind: 'update',
  turnId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
});

/** Items over a chat the session `key` joins on `commit()`, with a clock the test moves. */
function chatOver(key: string) {
  const out: any[] = [];
  let owner = key;
  let current: string | null = null;
  let now = 0;
  const waits = new Map<number, { at: number; fn: () => void }>();
  let n = 0;
  const timers = {
    set: (fn: () => void, ms: number) => (waits.set(++n, { at: now + ms, fn }), n),
    clear: (id: number) => void waits.delete(id),
  };
  const items = new AcpItems({
    chatOf: () => owner,
    nativeOf: (chat: string) => (chat === owner && owner === key ? key : current),
    cwdOf: () => '/repo',
    emit: (chatId: string, _key: string, method: string, params: any) => out.push({ chatId, method, params }),
    timers,
  });
  return {
    out,
    items,
    commit() {
      owner = 'claude:stable';
      current = key;
    },
    tick(ms: number) {
      now += ms;
      for (const [id, w] of [...waits]) if (w.at <= now) waits.delete(id), w.fn();
    },
  };
}

test('commands before commit never poison the following stable-chat stream', () => {
  const key = 'acp:kimi:prepared-commands';
  const c = chatOver(key);
  c.items.onEvent({ key, kind: 'update', turnId: null, update: { sessionUpdate: 'available_commands_update', availableCommands: [] } });
  c.commit();
  c.items.onEvent({ key, kind: 'turnStart', turnId: 'current' });
  c.items.onEvent(chunk(key, 'current', 'a visible reply, long enough to tell what it is'));
  c.items.onEvent({ key, kind: 'turnEnd', turnId: 'current', stopReason: 'end_turn', error: null });
  assert.ok(c.out.length > 0);
  assert.ok(c.out.every((x) => x.chatId === 'claude:stable'));
});

test('a read after the owner changed drops an active precommit translator instead of following its old owner', async () => {
  const key = 'acp:kimi:prepared-active';
  const c = chatOver(key);
  c.items.onEvent({ key, kind: 'turnStart', turnId: 'old' });
  c.commit();
  const read = await c.items.history(key, 'claude:stable', '/repo', async () => ({ file: '', extra: [] }));
  assert.equal(read.activeTurnId, null);
  assert.equal(c.items.get(key), undefined);
});

test('a stray timer and a close cannot finish a translator whose stable owner changed', () => {
  for (const via of ['timer', 'closed']) {
    const key = `acp:kimi:prepared-${via}`;
    const c = chatOver(key);
    c.items.onEvent(chunk(key, null, 'unattended'));
    c.commit();
    c.out.length = 0;
    if (via === 'closed') assert.deepEqual(c.items.onEvent({ key, kind: 'closed', error: 'agent exited' }), { working: false });
    c.tick(STRAY_MS);
    assert.deepEqual(c.out, [], via);
  }
});

test('owned stray timers finish only unattended turns, each burst restarts the wait', () => {
  for (const phase of ['auto', 'current', 'completed']) {
    const key = `acp:kimi:owned-${phase}`;
    const c = chatOver(key);
    if (phase !== 'auto') c.items.onEvent({ key, kind: 'turnStart', turnId: 'current' });
    c.items.onEvent(chunk(key, null, 'reply'));
    c.tick(1000);
    c.items.onEvent(chunk(key, null, 'more'));
    c.tick(1000);
    assert.equal(
      c.out.some((x) => x.method === 'turn/completed'),
      false,
      'each burst restarts the wait',
    );
    if (phase === 'completed') c.items.onEvent({ key, kind: 'turnEnd', turnId: 'current', stopReason: 'end_turn', error: null });
    c.out.length = 0;
    c.tick(STRAY_MS);
    assert.equal(
      c.out.some((x) => x.method === 'turn/completed'),
      phase === 'auto',
      phase,
    );
  }
});
