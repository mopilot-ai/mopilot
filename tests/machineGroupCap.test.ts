// A machine with thousands of chats is drawn as its newest few hundred (src/components/sidebar/machineGroupData.ts): the rest is said, never drawn, and this Mac's own chats are all kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROUP_ROW_CAP, machineGroups } from '../src/components/sidebar/machineGroupData.ts';

const thread = (id: string) => ({ id, updatedAt: 1 }) as any;
const row = (n: number) =>
  ({ chatId: `claude:c${n}`, title: `t ${n}`, harness: 'claude', createdAt: 1, updatedAt: n, epoch: 1, rev: 1, state: 'idle' }) as any;

test('2,000 chats of a machine make GROUP_ROW_CAP rows, the newest, with the group saying the older ones are not listed; this Mac keeps all of its own', () => {
  const mine = ['m0', 'm1', 'm2'];
  const groups = machineGroups({
    roots: mine,
    threads: Object.fromEntries(mine.map((id) => [id, thread(id)])),
    ownerOf: (id) => (id.startsWith('m') ? 'a' : ''),
    hidden: () => false,
    machines: [{ id: 'a', name: 'box', status: 'online' } as any],
    indexed: new Map([
      ['a', { machineId: 'a', state: 'ready', truncated: false, rows: Array.from({ length: 2000 }, (_, i) => row(i + 1)) } as any],
    ]),
    answered: true,
    ownersKnown: true,
    macName: 'This Mac',
  });
  const g = groups[1];
  assert.equal(g.rows.filter((r) => r.kind === 'remote').length, GROUP_ROW_CAP);
  assert.equal(g.rows.filter((r) => r.kind === 'thread').length, 3);
  assert.equal(g.truncated, true);
  assert.equal((g.rows.find((r) => r.kind === 'remote') as any).row.chatId, 'claude:c2000', 'the newest are kept');
  assert.equal(groups[0].truncated, false);
});

test('a chat that runs or waits for a person is kept however old it is: the cap never hides the one a person must find', () => {
  const rows = Array.from({ length: 2000 }, (_, i) => row(i + 1));
  rows[0] = { ...rows[0], state: 'attention' };
  rows[1] = { ...rows[1], state: 'running' };
  const groups = machineGroups({
    roots: [],
    threads: {},
    ownerOf: () => '',
    hidden: () => false,
    machines: [{ id: 'a', name: 'box', status: 'online' } as any],
    indexed: new Map([['a', { machineId: 'a', state: 'ready', truncated: false, rows } as any]]),
    answered: true,
    ownersKnown: true,
    macName: 'This Mac',
  });
  const kept = groups[1].rows.map((r) => (r as any).row.chatId);
  assert.equal(kept.length, GROUP_ROW_CAP + 2);
  assert.ok(kept.includes('claude:c1') && kept.includes('claude:c2'), 'the oldest two, one waiting and one running, are there');
  assert.equal(groups[1].truncated, true);
});
