// Main's manual compaction lifetime survives real ACP turn-id adoption and clears on completion, Stop and refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, selectSegment } from './support/controller/fixture';

const require = createRequire(import.meta.url);
const { AcpTurns } = require('../electron/harness/acpTurns.cjs');
const { sendPrompt } = require('../electron/harness/acp/prompt.cjs');
const compact = { id: 'compact', text: '/compact', attachments: [], opts: { human: true, compact: { args: '' } } };

for (const ending of ['completed', 'stopped', 'failed']) {
  test(`manual ACP compaction is main-owned through native turn start and ${ending}`, async () => {
    const { c, chats, state } = setup();
    selectSegment(c, chats, 'chat', [['acp:kimi', 's']]);
    state.patch('chat', { acp: { commands: ['compress'] } });
    const sent: any[] = [];
    const chat: any = {
      harness: 'kimi',
      sessionId: 's',
      state: {},
      agent: { caps: {}, request: (...args: any[]) => (sent.push(args), new Promise(() => {})) },
    };
    const host: any = {
      starting: new Map(),
      ensure: async () => chat,
      items: { append: () => {} },
      emitEvent: (event: any) => c.onAcpEvent(event),
      now: () => 0,
      audioDispatch: {},
    };
    c.acp.send = (...args: any[]) => sendPrompt(host, ...args);
    c.acpTurns = new AcpTurns({
      send: (...args: any[]) => c.acpSend(...args),
      rename: () => {},
      readImage: async () => null,
      named: () => true,
    });
    if (ending === 'failed')
      c.acp.send = async () => {
        throw new Error('Compaction refused');
      };
    const receipt = await c.send('chat', compact, 1, true);
    const snapshot = state.snapshot('chat');
    if (ending === 'failed') {
      assert.equal(receipt.action, 'queued');
      assert.equal(snapshot.activeTurn, null);
      assert.equal(snapshot.queue[0].opts.compact.args, '');
      assert.match(snapshot.crashed, /Compaction refused/);
      return;
    }
    assert.equal(receipt.action, 'started');
    assert.equal(snapshot.activeTurn.id, chat.prompting.turnId);
    assert.equal(snapshot.activeTurn.compact, true);
    assert.deepEqual(sent[0], ['session/prompt', { sessionId: 's', prompt: [{ type: 'text', text: '/compress' }] }]);
    if (ending === 'stopped') c.noteStop('chat');
    c.end('chat', { drain: false });
    assert.equal(state.snapshot('chat').activeTurn, null);
    // An unrelated native turn cannot inherit the previous maintenance status.
    c.onAcpEvent({ key: c.ref('chat').key, kind: 'turnStart', turnId: 'at-next', human: true });
    assert.equal(state.snapshot('chat').activeTurn.compact, undefined);
  });
}

test('compaction dispatch without an owned turn never manufactures an active-turn marker', async () => {
  const { c, state } = setup();
  assert.equal((await c.dispatch('claude:s', 'turn', compact, null)).started, true);
  assert.equal(state.snapshot('claude:s').activeTurn, null);
});
