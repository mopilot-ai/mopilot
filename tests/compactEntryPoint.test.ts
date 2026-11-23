// Native compaction has one queued semantic entry point, without renderer adapter handlers that bypass main's queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_HANDLERS } from '../src/session/harness/adapters/codexSemantics.ts';
import { CLAUDE_HANDLERS } from '../src/session/harness/adapters/claudeSemantics.ts';
import { runSemantic } from '../src/store/session/runSemantic.ts';
import { useFakeNative } from './support/ports/native.ts';

test('compaction always uses the shared queue rather than a renderer-native handler', () => {
  assert.equal(Object.hasOwn(CODEX_HANDLERS, 'compact'), false);
  assert.equal(Object.hasOwn(CLAUDE_HANDLERS, 'compact'), false);
});

test('runSemantic queues a typed compaction action for every harness with its arguments intact', async (t) => {
  let kind = 'codex';
  const native = useFakeNative(t, {
    session: {
      caps: async () => ({ kind, caps: { compact: { state: 'native', via: 'rpc' } } }),
      send: async () => ({ action: 'started', id: 'compact' }),
    },
  });
  for (kind of ['codex', 'claude', 'acp:kimi']) {
    for (const args of ['', 'Keep the rollout decisions']) {
      assert.equal((await runSemantic('chat', 'compact', args)).ok, true);
      assert.deepEqual(native.callsTo('session.send').at(-1), [
        'chat',
        {
          text: `/compact${args ? ` ${args}` : ''}`,
          attachments: [],
          opts: { human: true, retainInMain: true, compact: { args } },
        },
      ]);
    }
  }
});
