// The machine page and Home card for a Host that lost its side of the direct link (#4721): the stored record says Direct, the Host does not answer, so the phone says "Not reachable directly", offers Reconnect while the Mac reaches the machine, and can remove the record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click } from './support/phone/component-kit';
import { withDirect, type DirectFacts, type Machine } from '../mobile/src/remote/machines';
import { waitFor } from './support/waitFor.ts';
import { away, local, open, path, studio, tapRow } from './support/phone/machine-page-kit';

const text = () => document.body.textContent ?? '';

test('a stored Direct record whose Host does not answer reads Not reachable directly, with Reconnect while the Mac reaches the machine; Reconnect enrols it again', async () => {
  const p = path({ enrolled: true });
  const old = { ...p.stored().h1 };
  await open({ direct: p.direct, machines: [local, studio] });
  await tapRow(/^Studio/);
  // the page reads the Host as it opens; the Host answers nothing
  await waitFor(() => /Not reachable directly/.test(text()), 'the page to say so');
  assert.match(text(), /is not linked to the relay: approvals cannot reach this phone/);
  assert.doesNotMatch(text(), /Reach.*Direct(?!ly)/);
  await click('Reconnect');
  await waitFor(() => p.enrolls.length === 1, 'the phone to enrol the Host again');
  await waitFor(() => p.stored().h1.hostId !== old.hostId, 'the record to be replaced');
});

test('with the Mac away the page says the machine does not answer and offers no Reconnect, which only the Mac can introduce', async () => {
  const p = path({ enrolled: true });
  await open({ direct: p.direct, machines: null, snap: away });
  await tapRow(/^Studio/);
  await waitFor(() => /Not reachable directly/.test(text()), 'the page to say so');
  assert.match(text(), /Studio does not answer\./);
  assert.doesNotMatch(text(), /Reconnect/);
});

test('Remove this machine asks first; Keep leaves the record, Remove takes it off the phone and closes the page', async () => {
  const p = path({ enrolled: true });
  await open({ direct: p.direct, machines: [local, studio] });
  await tapRow(/^Studio/);
  await click('Remove this machine');
  assert.match(text(), /Remove Studio from this phone\?/);
  await click('Keep');
  assert.doesNotMatch(text(), /Remove Studio from this phone\?/);
  assert.ok('h1' in p.stored());
  await click('Remove this machine');
  await click('Remove');
  await waitFor(() => !('h1' in p.stored()), 'the record to go');
  await waitFor(() => !/Remove this machine/.test(text()), 'the page to close');
});

test('a machine that is not enrolled has nothing to remove and nothing to reconnect', async () => {
  const p = path();
  await open({ direct: p.direct, machines: [local, studio] });
  await tapRow(/^Studio/);
  assert.doesNotMatch(text(), /Remove this machine|Reconnect/);
});

test('the Mac’s list joined with the phone’s read of each Host: directDown only where an enrolled Host did not answer', () => {
  const row = (id: string): Machine =>
    ({ id, name: id, status: 'online', line: 'Online', tone: 'ok', keepRunning: null, agents: [] }) as Machine;
  const facts = (reachable: Record<string, boolean | null>): DirectFacts => ({
    records: [
      { machineId: 'a', name: 'a' },
      { machineId: 'b', name: 'b' },
      { machineId: 'only', name: 'only' },
      { machineId: 'fine', name: 'fine' },
    ],
    waiting: () => 0,
    reachable: (id) => reachable[id] ?? null,
    agents: () => null,
  });
  const joined = withDirect([row('local'), row('a'), row('b'), row('c')], facts({ a: false, b: true, only: false, fine: true }))!;
  assert.deepEqual(
    joined.map((m) => [m.id, m.reach, m.directDown ?? false]),
    [
      ['local', undefined, false],
      ['a', 'direct', true],
      ['b', 'direct', false],
      ['c', 'through', false],
      ['only', 'direct', true],
      ['fine', 'direct', false],
    ],
  );
});
