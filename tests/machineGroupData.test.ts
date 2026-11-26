// The "By machine" groups (src/components/sidebar/machineGroupData.ts): this Mac first, then each machine in the registry's order; a chat of this Mac's own records sits where it runs, a chat only a Host lists is a row of its machine, newest first, and each state of a machine's list says its one line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAC_GROUP, STATE_NOTES, TRUNCATED_NOTE, machineGroups } from '../src/components/sidebar/machineGroupData.ts';

const thread = (id: string, updatedAt: number) => ({ id, title: id, updatedAt, preview: '', cwd: '/x' }) as any;
const machine = (id: string, status = 'online', extra: object = {}) => ({ id, name: `box ${id}`, status, ...extra }) as any;
const row = (chatId: string, updatedAt: number, state = 'idle') =>
  ({ chatId, title: `t ${chatId}`, harness: 'claude', createdAt: 1, updatedAt, epoch: 1, rev: 1, state }) as any;
const index = (machineId: string, state: string, rows: any[] = []) => ({ machineId, state, truncated: false, rows }) as any;

function build(o: Partial<Parameters<typeof machineGroups>[0]> = {}) {
  return machineGroups({
    roots: [],
    threads: {},
    ownerOf: () => '',
    hidden: () => false,
    machines: [],
    indexed: new Map(),
    answered: true,
    ownersKnown: true,
    macName: 'This Mac',
    ...o,
  });
}

test('this Mac is first and has no dot; each machine follows in the registry order with a green or grey dot and its cloud record', () => {
  const cloud = { provider: 'oci', id: 'vm', region: 'r', size: 's', network: 'full' } as const;
  const groups = build({ machines: [machine('a'), machine('b', 'offline'), machine('c', 'attention', { cloud })] });
  assert.deepEqual(
    groups.map((g) => [g.key, g.id, g.name, g.dot]),
    [
      [MAC_GROUP, '', 'This Mac', null],
      ['machine:a', 'a', 'box a', 'on'],
      ['machine:b', 'b', 'box b', 'off'],
      ['machine:c', 'c', 'box c', 'on'],
    ],
  );
  assert.equal(groups[3].cloud, cloud);
  assert.equal(groups[0].cloud, undefined);
});

test('a chat of this Mac sits in its machine, in seconds against a Host row in ms, newest first; a chat the Mac already has is not listed twice', () => {
  const threads = { m1: thread('m1', 300), m2: thread('m2', 100), 'acp:host-claude:one': thread('acp:host-claude:one', 200) };
  const groups = build({
    roots: ['m1', 'm2', 'acp:host-claude:one'],
    threads,
    ownerOf: (id) => (id === 'acp:host-claude:one' ? 'a' : ''),
    machines: [machine('a')],
    indexed: new Map([['a', index('a', 'ready', [row('claude:one', 250_000), row('claude:two', 150_000), row('claude:three', 400_000)])]]),
  });
  assert.deepEqual(
    groups[0].rows.map((r) => r.key),
    ['m1', 'm2'],
  );
  // `claude:one` is the Mac's own record `acp:host-claude:one` (drawn from the record); two and three are the machine's alone
  assert.deepEqual(
    groups[1].rows.map((r) => [r.kind, r.key]),
    [
      ['remote', 'a:claude:three'],
      ['thread', 'acp:host-claude:one'],
      ['remote', 'a:claude:two'],
    ],
  );
  assert.equal(groups[1].empty, false);
});

test('a chat nested under another (a record that is not a root) and a chat this Mac archived are not drawn again from the machine', () => {
  const groups = build({
    threads: { 'acp:host-claude:child': thread('acp:host-claude:child', 1) },
    hidden: (id) => id === 'acp:host-claude:gone',
    machines: [machine('a')],
    indexed: new Map([['a', index('a', 'ready', [row('claude:child', 5), row('claude:gone', 6), row('claude:kept', 7)])]]),
  });
  assert.deepEqual(
    groups[1].rows.map((r) => r.key),
    ['a:claude:kept'],
  );
});

test('a chat on a machine the registry no longer lists keeps a group of its own under its id, offline', () => {
  const groups = build({ roots: ['x'], threads: { x: thread('x', 1) }, ownerOf: () => 'lost', machines: [machine('a')] });
  const lost = groups.find((g) => g.id === 'lost')!;
  assert.deepEqual([lost.name, lost.dot, lost.rows.length], ['lost', 'off', 1]);
});

test('a chat whose record is gone (not in the records) is skipped', () => {
  assert.deepEqual(build({ roots: ['ghost'] })[0].rows, []);
});

test('each state of a machine list says one line: loading, partial, failed, stale, unsupported; ready says none', () => {
  const states = ['loading', 'ready', 'partial', 'failed', 'stale', 'unsupported'];
  const groups = build({
    machines: states.map((s) => machine(s)),
    indexed: new Map(states.map((s) => [s, index(s, s, s === 'loading' ? [] : [row(`claude:${s}`, 1)])])),
  });
  const note = (id: string) => groups.find((g) => g.id === id)!.note;
  assert.equal(note('loading'), STATE_NOTES.loading);
  assert.equal(note('ready'), null);
  assert.equal(note('partial'), STATE_NOTES.partial);
  assert.equal(note('failed'), STATE_NOTES.failed);
  assert.equal(note('stale'), STATE_NOTES.stale);
  assert.equal(note('unsupported'), STATE_NOTES.unsupported);
  assert.equal(groups.find((g) => g.id === 'loading')!.loading, true);
  assert.equal(groups.find((g) => g.id === 'partial')!.loading, false, 'a partial list shows its rows');
  for (const line of Object.values(STATE_NOTES)) assert.ok(line.length <= 40 && !line.includes('\n'), line);
});

test('an offline machine whose list is still ready reads as stale; one with no list yet is loading until the Mac has answered, then it is empty', () => {
  const offline = build({ machines: [machine('a', 'offline')], indexed: new Map([['a', index('a', 'ready', [row('claude:x', 9)])]]) });
  assert.equal(offline[1].note, STATE_NOTES.stale);
  assert.equal(offline[1].rows.length, 1);
  const waiting = build({ machines: [machine('a')], answered: false });
  assert.deepEqual([waiting[1].note, waiting[1].loading, waiting[1].empty], [STATE_NOTES.loading, true, false]);
  const answered = build({ machines: [machine('a')], answered: true });
  assert.deepEqual([answered[1].note, answered[1].loading, answered[1].empty], [null, false, true]);
});

test('"No chats" is for a list that is empty and not wrong: a failed or unsupported one says what is wrong instead', () => {
  const groups = build({
    machines: [machine('ok'), machine('bad'), machine('old'), machine('part')],
    indexed: new Map([
      ['ok', index('ok', 'ready')],
      ['bad', index('bad', 'failed')],
      ['old', index('old', 'unsupported')],
      ['part', index('part', 'partial')],
    ]),
  });
  assert.deepEqual(
    groups.map((g) => [g.id, g.empty]),
    [
      ['', true],
      ['ok', true],
      ['bad', false],
      ['old', false],
      ['part', true],
    ],
  );
});

test('a list that leaves older chats out says so; a whole list does not', () => {
  const whole = build({ machines: [machine('a')], indexed: new Map([['a', index('a', 'ready', [row('claude:x', 1)])]]) });
  const cut = build({
    machines: [machine('a')],
    indexed: new Map([['a', { ...index('a', 'ready', [row('claude:x', 1)]), truncated: true }]]),
  });
  assert.deepEqual([whole[0].truncated, whole[1].truncated, cut[1].truncated], [false, false, true]);
  assert.ok(TRUNCATED_NOTE.length <= 40);
});

test('the same chat id on two machines is two rows, each keyed by its machine; a row is live only while its machine answers', () => {
  const groups = build({
    machines: [machine('a'), machine('b', 'offline'), machine('c')],
    indexed: new Map([
      ['a', index('a', 'ready', [row('claude:same', 5)])],
      ['b', index('b', 'ready', [row('claude:same', 5)])],
      ['c', index('c', 'stale', [row('claude:other', 5)])],
    ]),
  });
  const rows = groups.flatMap((g) => g.rows.map((r) => [r.key, (r as any).live]));
  assert.deepEqual(rows, [
    ['a:claude:same', true],
    ['b:claude:same', false],
    ['c:claude:other', false],
  ]);
});

test('until it is known which chats run where no chat is drawn, and every group says it is loading', () => {
  const groups = build({
    ownersKnown: false,
    roots: ['m1'],
    threads: { m1: thread('m1', 1) },
    machines: [machine('a')],
    indexed: new Map([['a', index('a', 'ready', [row('claude:x', 5)])]]),
  });
  assert.deepEqual(
    groups.map((g) => [g.rows.length, g.note, g.loading, g.empty]),
    [
      [0, STATE_NOTES.loading, true, false],
      [0, STATE_NOTES.loading, true, false],
    ],
  );
});

test('a chat deleted or archived here does not come back from the machine that still lists it', () => {
  const groups = build({
    hidden: (id) => id === 'acp:host-claude:deleted',
    machines: [machine('a', 'offline')],
    indexed: new Map([['a', index('a', 'stale', [row('claude:deleted', 9), row('claude:kept', 8)])]]),
  });
  assert.deepEqual(
    groups[1].rows.map((r) => r.key),
    ['a:claude:kept'],
  );
});
