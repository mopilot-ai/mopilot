// Removing a paired computer: the relay is asked within a bound, the keys go whatever it says, and nothing else's connection is cut.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createUnpairing, type RemoveComputerDeps } from '../mobile/src/removeComputer.ts';

function rig(over: Partial<RemoveComputerDeps> = {}) {
  const log: string[] = [];
  const state = { generation: 1, selected: null as string | null, connected: false, pairs: new Set(['a', 'b']), shown: [] as number[] };
  const deps: RemoveComputerDeps = {
    blocked: () => null,
    hasPair: async (id) => state.pairs.has(id),
    signedIn: () => true,
    generation: () => state.generation,
    selectedPair: () => state.selected,
    reaching: () => null,
    relayConnected: () => state.connected,
    connectRelay: async () => {
      log.push('connect');
      state.connected = true;
    },
    relayRemove: async (id) => {
      log.push(`relay:${id}`);
    },
    closeChannel: (id) => log.push(`close:${id}`),
    removePair: async (id) => state.pairs.delete(id),
    showPairs: async (owner) => {
      state.shown.push(owner);
    },
    disconnect: () => {
      log.push('disconnect');
      state.generation++;
      state.connected = false;
      state.selected = null;
    },
    publishError: (note) => log.push(`note:${note}`),
    ...over,
  };
  return { ...createUnpairing(deps), log, state };
}
const NOTE = /Remove this phone on your computer as well/;

test('a closed connection is opened for the relay, then closed again, and the pair is gone', async () => {
  const r = rig();
  await r.unpair('a');
  assert.deepEqual(r.log, ['connect', 'relay:a', 'close:a', 'disconnect', 'note:null']);
  assert.equal(r.state.pairs.has('a'), false);
  assert.equal(r.state.shown.length, 1, 'the list was shown once');
});

test('the open connection is used as it is, and a computer that is not the open one leaves it alone', async () => {
  const r = rig();
  r.state.connected = true;
  r.state.selected = 'b';
  await r.unpair('a');
  assert.deepEqual(r.log, ['relay:a', 'close:a', 'note:null']);
  assert.equal(r.state.generation, 1);
  assert.equal(r.state.selected, 'b');
});

test('removing the open computer ends its session', async () => {
  const r = rig();
  r.state.connected = true;
  r.state.selected = 'a';
  await r.unpair('a');
  assert.deepEqual(r.log, ['relay:a', 'close:a', 'disconnect', 'note:null']);
});

test('a pair that is already gone is not an error and does not ask the relay again', async () => {
  const r = rig();
  await r.unpair('a');
  r.log.length = 0;
  await r.unpair('a');
  assert.deepEqual(r.log, []);
});

test('a refused removal while a pairing is unfinished says why and changes nothing', async () => {
  const r = rig({ blocked: () => 'Finish or cancel pairing first' });
  await assert.rejects(r.unpair('a'), /Finish or cancel pairing first/);
  assert.equal(r.state.pairs.has('a'), true);
  assert.deepEqual(r.log, []);
});

test('signed out, the keys are deleted without asking the relay', async () => {
  const r = rig({ signedIn: () => false });
  await r.unpair('a');
  assert.deepEqual(r.log, ['close:a', 'disconnect', 'note:null']);
});

test('a relay that refuses or is unreachable still lets the keys go, and the person is told', async () => {
  const r = rig({
    relayRemove: async () => {
      throw new Error('relay: forbidden');
    },
  });
  await r.unpair('a');
  assert.equal(r.state.pairs.has('a'), false);
  assert.match(r.log.at(-1)!, NOTE);
  const gone = rig({
    relayRemove: async () => {
      throw new Error('relay: unknown_pair');
    },
  });
  await gone.unpair('a');
  assert.equal(gone.log.at(-1), 'note:null');
  const odd = rig({
    relayRemove: async () => {
      throw 'broken';
    },
  });
  await odd.unpair('a');
  assert.match(odd.log.at(-1)!, NOTE);
});

test('a silent relay is given up on after the bound', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const r = rig({ relayRemove: () => new Promise(() => {}) });
    const done = r.unpair('a');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    mock.timers.tick(8000);
    await done;
    assert.equal(r.state.pairs.has('a'), false);
    assert.match(r.log.at(-1)!, NOTE);
    const quick = rig({ timeoutMs: 5, relayRemove: () => new Promise(() => {}) });
    const second = quick.unpair('a');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    mock.timers.tick(5);
    await second;
    assert.match(quick.log.at(-1)!, NOTE);
  } finally {
    mock.timers.reset();
  }
});

test('a storage failure still closes the connection opened for the relay, and rejects', async () => {
  const r = rig({
    removePair: async () => {
      throw new Error('storage unavailable');
    },
  });
  await assert.rejects(r.unpair('a'), /storage unavailable/);
  assert.deepEqual(r.log, ['connect', 'relay:a', 'close:a', 'disconnect']);
});

test('something else taking over the connection while the relay answers is not cut off, and gets no note', async () => {
  let release!: () => void;
  const r = rig({ relayRemove: () => new Promise((resolve) => (release = () => resolve(undefined))) });
  r.state.connected = true;
  r.state.selected = 'b';
  const done = r.unpair('a');
  for (let i = 0; i < 20; i++) await Promise.resolve();
  r.state.generation++;
  release();
  await done;
  assert.deepEqual(r.log, ['close:a']);
  assert.equal(r.state.generation, 2);
  assert.equal(r.state.pairs.has('a'), false);
});

test('removals run one after another and each asks the relay itself', async () => {
  const r = rig();
  await Promise.all([r.unpair('a'), r.unpair('b'), r.unpair('a')]);
  assert.deepEqual(
    r.log.filter((l) => l.startsWith('relay:')),
    ['relay:a', 'relay:b'],
  );
  assert.equal(r.state.pairs.size, 0);
});

test('a failed removal does not stop the next one', async () => {
  let fail = true;
  const r = rig({
    blocked: () => (fail ? 'Finish or cancel pairing first' : null),
  });
  const first = r.unpair('a').then(
    () => 'ok',
    () => 'failed',
  );
  const second = (async () => {
    await first;
    fail = false;
    await r.unpair('a');
    return r.state.pairs.has('a');
  })();
  assert.equal(await first, 'failed');
  assert.equal(await second, false);
});

test('forgetting from a relay notice shows the list, and retries when a connection change retired the read', async () => {
  const r = rig();
  let calls = 0;
  const flaky = rig({
    showPairs: async () => {
      calls++;
      if (calls < 3) flaky.state.generation++;
    },
  });
  await flaky.forget('a');
  assert.equal(calls, 3);
  const exhausted = rig({
    showPairs: async () => {
      exhausted.state.generation++;
    },
  });
  await exhausted.forget('a');
  assert.equal(exhausted.state.pairs.has('a'), false);
  await r.forget('zzz');
  assert.deepEqual(r.state.shown, [], 'nothing was removed, nothing to show');
});

test('an attempt to reach this computer is called off before the removal, and a refused removal leaves it running', async () => {
  const r = rig({ reaching: () => 'a' });
  await r.unpair('a');
  assert.deepEqual(r.log, ['disconnect', 'connect', 'relay:a', 'close:a', 'disconnect', 'note:null']);
  assert.equal(r.state.pairs.has('a'), false);
  const other = rig({ reaching: () => 'b' });
  await other.unpair('a');
  assert.equal(other.log[0], 'connect', 'an attempt at another computer is not touched');
  const refused = rig({ reaching: () => 'a', blocked: () => 'Finish or cancel pairing first' });
  await assert.rejects(refused.unpair('a'), /Finish or cancel/);
  assert.deepEqual(refused.log, [], 'a removal that cannot start stops nothing');
});
