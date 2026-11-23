// ACP history opens publish only for their newest surviving native source, including rejected and delayed replies.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fx, reset } from './support/harness-logic-fakes.ts';
import { controlledReads } from './support/async-scenarios.ts';

const { openAcpThread } = await import('../src/session/harness/acp.ts');
const ID = 'acp:kimi:history-owner';
const page = (id: string) => ({
  page: new TextEncoder().encode(JSON.stringify({ turns: [{ id, status: 'completed', items: [] }], olderCursor: null })),
  activeTurnId: null,
  diffs: {},
});
beforeEach(() => reset());

test('an older ACP open never replaces a newer page or clears its loading flag', async () => {
  for (const order of ['old-first', 'old-last']) {
    for (const reject of [false, true]) {
      reset();
      const reads = controlledReads<any>();
      fx.native.acp = { turns: reads.read };
      const old = openAcpThread(ID);
      const next = openAcpThread(ID);
      const settleOld = async () => {
        if (reject) reads.requests[0].reject(new Error('obsolete failure'));
        else reads.requests[0].resolve(page('obsolete'));
        await old;
      };
      if (order === 'old-first') {
        await settleOld();
        assert.equal(fx.state.runtime[ID].loading, true);
        assert.equal(fx.state.runtime[ID].error, null);
      }
      reads.requests[1].resolve(page('current'));
      await next;
      if (order === 'old-last') await settleOld();
      assert.deepEqual(
        fx.state.runtime[ID].turns.map((t: any) => t.id),
        ['current'],
      );
      assert.equal(fx.state.runtime[ID].loading, false);
      assert.equal(fx.state.runtime[ID].error, null);
    }
  }
});

test('an ACP source switch and a round trip cannot publish the old page or its error', async () => {
  for (const roundTrip of [false, true]) {
    for (const reject of [false, true]) {
      reset();
      const reads = controlledReads<any>();
      fx.native.acp = { turns: reads.read };
      const opening = openAcpThread(ID);
      fx.state.segments[ID] = [{ harness: 'codex', nativeId: 'next', start: 0 }];
      if (roundTrip) fx.state.segments[ID] = [{ harness: 'acp:kimi', nativeId: ID, start: 0 }];
      fx.state.runtime[ID].turns = [{ id: 'new-source', items: [] }];
      if (reject) reads.requests[0].reject(new Error('obsolete failure'));
      else reads.requests[0].resolve(page('obsolete'));
      await opening;
      assert.deepEqual(
        fx.state.runtime[ID].turns.map((t: any) => t.id),
        ['new-source'],
      );
      assert.equal(fx.state.runtime[ID].error, null);
      assert.equal(fx.state.runtime[ID].loading, false);
    }
  }
});
