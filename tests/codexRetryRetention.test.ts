// A failed-turn Retry stays main-owned across a native writer lock, rather than entering an invisible renderer hold.
import { createRequire } from 'node:module';
import { test, assert, setup } from './support/codex-adapter/fixture.ts';
const { ThreadLocked } = createRequire(import.meta.url)('../electron/harness/codexLeases.cjs');

test('a native writer lock leaves conditional Retry in main and emits no renderer-held duplicate', async () => {
  const { a, events } = setup();
  a.ensureResumed = async () => {
    throw new ThreadLocked();
  };
  const result = await a.startTurn(
    'chat',
    { kind: 'codex', id: 'native', key: 'native' },
    {
      id: 'retry',
      text: 'hello',
      opts: { human: true, retainInMain: true },
    },
  );
  assert.equal(result.started, false);
  assert.equal(!!result.held, false);
  assert.match(result.error!, /another Codex app/);
  assert.equal(
    events.some(({ e }: any) => e.kind === 'locked'),
    false,
  );
});

test('ordinary writer-lock input still uses its existing renderer hold', async () => {
  const { a, events } = setup();
  a.ensureResumed = async () => {
    throw new ThreadLocked();
  };
  assert.equal((await a.startTurn('chat', { kind: 'codex', id: 'native', key: 'native' }, { text: 'ordinary', opts: {} })).held, true);
  assert.equal(
    events.some(({ e }: any) => e.kind === 'locked'),
    true,
  );
});
