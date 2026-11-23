// Pair commit reconciliation reports only a still-current storage read and propagates active failures.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRelayRouting } from '../mobile/src/relayRouting.ts';

test('failed pairing reports its original error after the current cleanup snapshot is read', async () => {
  const errors: unknown[] = [];
  const original = new Error('join refused');
  let refreshed = false;
  const routing = createRelayRouting({
    pairingSettled: () => {},
    channels: new Map(),
    selectedPair: () => null,
    interrupt: () => {},
    generation: () => 1,
    refreshPairs: async () => {
      refreshed = true;
    },
    reconciliationError: (error) => {
      assert.equal(refreshed, true);
      errors.push(error);
    },
  });
  await routing.failed(1, original);
  assert.deepEqual(errors, [original]);
});

test('failed pairing exposes an active snapshot read failure instead of remaining busy', async () => {
  const errors: unknown[] = [];
  const readError = new Error('storage unavailable');
  const routing = createRelayRouting({
    pairingSettled: () => {},
    channels: new Map(),
    selectedPair: () => null,
    interrupt: () => {},
    generation: () => 1,
    refreshPairs: async () => {
      throw readError;
    },
    reconciliationError: (error) => errors.push(error),
  });
  await assert.rejects(routing.failed(1, new Error('join refused')), readError);
  assert.deepEqual(errors, [readError]);
});

for (const replacement of [false, true]) {
  test(`failed pairing cannot publish to ${replacement ? 'a replacement established after the read' : 'an already retired owner'}`, async () => {
    let generation = replacement ? 1 : 2;
    const errors: unknown[] = [];
    const routing = createRelayRouting({
      pairingSettled: () => {},
      channels: new Map(),
      selectedPair: () => null,
      interrupt: () => {},
      generation: () => generation,
      refreshPairs: async () => {
        if (replacement)
          queueMicrotask(() =>
            queueMicrotask(() => {
              generation++;
            }),
          );
      },
      reconciliationError: (error) => errors.push(error),
    });
    await routing.failed(1, new Error('old failure'));
    assert.deepEqual(errors, []);
  });
}

test('an active commit refresh failure remains a visible operation failure', async () => {
  const errors: unknown[] = [];
  const routing = createRelayRouting({
    pairingSettled: () => {},
    channels: new Map(),
    selectedPair: () => null,
    interrupt: () => {},
    generation: () => 1,
    refreshPairs: async () => {
      throw new Error('storage unavailable');
    },
    reconciliationError: (error) => errors.push(error),
  });
  await assert.rejects(routing.committed(1), /storage unavailable/);
  assert.deepEqual(errors, []);
});

for (const replace of [false, true]) {
  test(`a retired commit refresh ${replace ? 'ignores an obsolete failure' : 'reports a current storage failure'}`, async () => {
    let generation = 1;
    let reject!: (error: Error) => void;
    const gate = new Promise<void>((_yes, no) => {
      reject = no;
    });
    const errors: unknown[] = [];
    const owners: number[] = [];
    const routing = createRelayRouting({
      pairingSettled: () => {},
      channels: new Map(),
      selectedPair: () => null,
      interrupt: () => {},
      generation: () => generation,
      refreshPairs: (owner) => {
        owners.push(owner);
        return gate;
      },
      reconciliationError: (error) => errors.push(error),
    });
    routing.joining('pair');
    generation = 2;
    routing.reset();
    const refreshing = routing.committed(1);
    if (replace) generation++;
    const error = new Error('read failed');
    reject(error);
    assert.equal(await refreshing, false);
    assert.deepEqual(owners, [2]);
    assert.deepEqual(errors, replace ? [] : [error]);
  });
}

for (const anotherRetirement of [false, true]) {
  test(`an old commit cannot report errors without its own retirement ${anotherRetirement ? 'after another joining attempt' : 'in this generation'}`, async () => {
    let generation = 2;
    const errors: unknown[] = [];
    const routing = createRelayRouting({
      pairingSettled: () => {},
      channels: new Map(),
      selectedPair: () => null,
      interrupt: () => {},
      generation: () => generation,
      refreshPairs: async () => {
        throw new Error('old read failed');
      },
      reconciliationError: (error) => errors.push(error),
    });
    if (anotherRetirement) {
      routing.joining('new-pair');
      generation++;
      routing.reset();
    }
    assert.equal(await routing.committed(1), false);
    assert.deepEqual(errors, []);
  });
}

test('the relay removing a committed pair makes the phone forget it; a pair still being made and other events do not', () => {
  const removed: string[] = [];
  const interrupts: string[] = [];
  const channels = new Map<string, any>([['p_mac', { receive: async () => {}, close() {} }]]);
  const routing = createRelayRouting({
    pairingSettled: () => {},
    channels,
    selectedPair: () => 'p_mac',
    interrupt: (error) => interrupts.push(error),
    generation: () => 1,
    refreshPairs: async () => {},
    reconciliationError: () => {},
    removed: (pair) => removed.push(pair),
  });
  routing.event({ ev: 'mailbox.dropped', pair: 'p_mac' });
  assert.deepEqual(removed, [], 'a dropped mailbox keeps the pair');
  routing.event({ ev: 'machine.presence', pair: 'p_mac', state: 'gone' });
  assert.deepEqual(removed, []);
  routing.event({ ev: 'pair.removed', pair: 'p_other' });
  assert.deepEqual(removed, ['p_other'], 'a pair that is not on screen is forgotten without an interruption');
  assert.equal(interrupts.length, 2);
  routing.joining('p_joining');
  routing.event({ ev: 'pair.removed', pair: 'p_joining' });
  assert.deepEqual(removed, ['p_other'], 'the pairing flow owns its own cleanup');
  routing.event({ ev: 'pair.removed', pair: 'p_mac' });
  assert.deepEqual(removed, ['p_other', 'p_mac']);
  assert.equal(channels.size, 0);
});

test('a removal event with no handler wired still closes the channel', () => {
  const channels = new Map<string, any>([['p_mac', { receive: async () => {}, close() {} }]]);
  const routing = createRelayRouting({
    pairingSettled: () => {},
    channels,
    selectedPair: () => null,
    interrupt: () => {},
    generation: () => 1,
    refreshPairs: async () => {},
    reconciliationError: () => {},
  });
  routing.event({ ev: 'pair.removed', pair: 'p_mac' });
  assert.equal(channels.size, 0);
});

const resyncRig = (probe: (() => Promise<unknown>) | undefined, selected: () => string | null = () => 'p_mac', generation = () => 1) => {
  const interrupts: Array<[string, string]> = [];
  const routing = createRelayRouting({
    pairingSettled: () => {},
    channels: new Map(),
    selectedPair: selected,
    interrupt: (error, phase) => interrupts.push([error, phase]),
    generation,
    refreshPairs: async () => {},
    reconciliationError: () => {},
    probe,
    probeMs: 20,
  });
  return { routing, interrupts };
};

test('a resync notice: an answer (even an error) is left alone; a lost link reconnects; silence twice is reported once, with what to do', async () => {
  const ok = resyncRig(async () => ({}));
  await ok.routing.resync('p_mac');
  assert.deepEqual(ok.interrupts, []);
  const refused = resyncRig(async () => {
    throw new Error('That is not allowed.');
  });
  await refused.routing.resync('p_mac');
  assert.deepEqual(refused.interrupts, [], 'the computer answered, so its session is open');
  const odd = resyncRig(async () => {
    throw 'not an Error';
  });
  await odd.routing.resync('p_mac');
  assert.deepEqual(odd.interrupts, []);
  for (const message of ['relay disconnected', 'Connection closed', 'Connect to a computer first']) {
    const lost = resyncRig(async () => {
      throw new Error(message);
    });
    await lost.routing.resync('p_mac');
    assert.deepEqual(lost.interrupts, [['Connection lost. Reconnecting…', 'offline']], message);
  }
  let calls = 0;
  const silent = resyncRig(() => (calls++, new Promise(() => {})));
  await silent.routing.resync('p_mac');
  assert.equal(calls, 2, 'asked twice before giving up');
  assert.equal(silent.interrupts.length, 1);
  assert.equal(silent.interrupts[0][1], 'error');
  assert.match(silent.interrupts[0][0], /Restart MoPilot on the computer.*pair it again/);
  let slow = 0;
  const late = resyncRig(() => (++slow === 1 ? new Promise(() => {}) : Promise.resolve({})));
  await late.routing.resync('p_mac');
  assert.deepEqual(late.interrupts, [], 'a slow first answer is not a failure');
});

test('a resync notice for another computer, with no probe wired, or overtaken by a new connection changes nothing', async () => {
  const other = resyncRig(async () => {
    throw new Error('x');
  });
  await other.routing.resync('p_other');
  assert.deepEqual(other.interrupts, []);
  const none = resyncRig(undefined);
  await none.routing.resync('p_mac');
  assert.deepEqual(none.interrupts, []);
  let gen = 1;
  const late = resyncRig(
    async () => {
      gen = 2;
      throw new Error('x');
    },
    () => 'p_mac',
    () => gen,
  );
  await late.routing.resync('p_mac');
  assert.deepEqual(late.interrupts, [], 'the connection changed while the probe ran');
  let sel: string | null = 'p_mac';
  const moved = resyncRig(
    async () => {
      sel = null;
      throw new Error('x');
    },
    () => sel,
  );
  await moved.routing.resync('p_mac');
  assert.deepEqual(moved.interrupts, []);
});

test('a pairing that failed for a reason unrelated to the account settles; any other failure is reported', async () => {
  const seen: string[] = [];
  const routing = createRelayRouting({
    channels: new Map(),
    selectedPair: () => null,
    interrupt: () => {},
    generation: () => 1,
    refreshPairs: async () => {},
    reconciliationError: (error: unknown) => void seen.push(`reported:${(error as Error).message}`),
    pairingSettled: (owner: number) => void seen.push(`settled:${owner}`),
    removed: () => {},
  } as any);
  await routing.failed(1, new Error('relay: forbidden'));
  await routing.failed(1, new Error('relay: taken'));
  await routing.failed(1, new Error('invalid QR'));
  await routing.failed(1, new Error('relay connection closed'));
  await routing.failed(1, new Error('storage failed'));
  await routing.failed(2, new Error('relay: forbidden'));
  assert.deepEqual(seen, ['settled:1', 'settled:1', 'settled:1', 'settled:1', 'reported:storage failed']);
});

test('an unreadable frame ends the selected or connecting pair, and only closes the channel of any other', async () => {
  const boom = new Error('cannot read');
  const make = (connecting?: () => string | null) => {
    const closed: string[] = [];
    const channels = new Map<string, any>(
      ['p_sel', 'p_conn', 'p_other'].map((id) => [id, { receive: async () => Promise.reject(boom), close: () => void closed.push(id) }]),
    );
    const routing = createRelayRouting({
      channels,
      selectedPair: () => 'p_sel',
      ...(connecting ? { connecting } : {}),
      interrupt: () => {},
      generation: () => 1,
      refreshPairs: async () => {},
      reconciliationError: () => {},
      pairingSettled: () => {},
    } as any);
    return { routing, closed, channels };
  };
  const withConnecting = make(() => 'p_conn');
  await assert.rejects(withConnecting.routing.receive({ pair: 'p_sel' }), boom);
  await assert.rejects(withConnecting.routing.receive({ pair: 'p_conn' }), boom);
  await withConnecting.routing.receive({ pair: 'p_other' });
  assert.deepEqual(withConnecting.closed, ['p_other']);
  assert.equal(withConnecting.channels.has('p_other'), false);
  const without = make();
  await assert.rejects(without.routing.receive({ pair: 'p_sel' }), boom);
  await without.routing.receive({ pair: 'p_conn' });
  assert.deepEqual(without.closed, ['p_conn']);
});
