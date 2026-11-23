// The Changes pane's source seam (src/lib/changesSource.ts, src/lib/machineChangesSource.ts): this Mac's git and a machine's Host answer the same fixture diff with the same files, take the same commit and discard calls, and say the same about a folder that is no repository; a read the pane no longer wants says nothing; the machine source declares what it cannot offer, each with its reason, in one place.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

const discards: unknown[][] = [];
const done = { ok: true, stdout: '', stderr: '' };
mock.module('../src/lib/gitDiscard.ts', {
  namedExports: {
    discardGitChanges: async (_git: unknown, root: string) => (discards.push([root, null]), done),
    discardGitFile: async (_git: unknown, root: string, file: string) => (discards.push([root, file]), done),
    restoreFromRoot: async () => done,
  },
});
const { localChangesSource } = await import('../src/lib/changesSource.ts');
const { machineChangesSource, machineCapabilities } = await import('../src/lib/machineChangesSource.ts');
const { parseUnifiedDiff } = await import('../src/lib/diff.ts');

const BOX = { id: 'ssh:me@box', name: 'box' };
const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1,2 @@',
  ' one',
  '+two',
  'diff --git a/top.md b/top.md',
  '--- a/top.md',
  '+++ b/top.md',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n');
const ok = (stdout = '') => ({ ok: true, stdout, stderr: '' });
const live = () => true;

let fake: ReturnType<typeof fakeNative>;
let hostDiff: () => Promise<any>;
let info: () => Promise<any>;
let localDiff: () => Promise<string>;
let status: () => Promise<any>;
let hostTurn: (q: any) => Promise<any>;
beforeEach(() => {
  discards.length = 0;
  hostDiff = async () => ({ value: { isRepo: true, patch: PATCH, truncated: false, unreadable: false } });
  info = async () => ({ root: '/repo' });
  localDiff = async () => PATCH;
  status = async () => ({ files: [] });
  hostTurn = async () => ({ value: { isRepo: true, baseline: true, patch: PATCH, truncated: false } });
  fake = fakeNative({
    git: {
      info: () => info(),
      diff: () => localDiff(),
      // The branch scope reads the default's merge base and patch.
      run: async (_cwd: string, [flag, command]: string[]) => {
        assert.equal(flag, '--no-lazy-fetch');
        if (command === 'merge-base') return ok('a'.repeat(40));
        return ok(command === 'diff' ? PATCH : '');
      },
      status: () => status(),
      commitFiles: async () => ok(),
    },
    host: {
      gitDiff: () => hostDiff(),
      gitTurnDiff: (_id: string, q: unknown) => hostTurn(q),
      gitCommit: async () => ({ value: { ok: true, stderr: '' } }),
      gitDiscard: async () => ({ value: { ok: true, stderr: '' } }),
    },
  });
  installNative(fake);
});

/** Both sources for the same folder, as the pane gets them. */
const sources = () =>
  [
    ['this Mac', localChangesSource('/repo')],
    [BOX.name, machineChangesSource(BOX, '/repo')],
  ] as const;

test('both sources read the same files from the same diff, in each scope', async () => {
  const expected = parseUnifiedDiff(PATCH);
  for (const [name, source] of sources())
    for (const scope of ['uncommitted', 'branch'] as const) {
      const read = await source.read(scope, false, live);
      assert.deepEqual(read, { kind: 'files', root: '/repo', files: expected, conflicted: [] }, `${name}: ${scope}`);
    }
  // the machine is asked for the scope and folder; this Mac's git for its repository root
  assert.deepEqual(fake.callsTo('host.gitDiff').at(-1), [BOX.id, { path: '/repo', scope: 'branch' }]);
});

test('files in conflict are marked the same on both sources, and a Host that does not say marks none', async () => {
  // this Mac's status rows carry `conflicted` (electron/platform/gitQueries.cjs); a Host's diff names the unmerged paths
  status = async () => ({
    files: [
      { code: 'UU', path: 'src/a.ts', added: 1, removed: 0, conflicted: true },
      { code: ' M', path: 'top.md', added: 1, removed: 1 },
    ],
  });
  hostDiff = async () => ({ value: { isRepo: true, patch: PATCH, truncated: false, unreadable: false, conflicted: ['src/a.ts'] } });
  for (const [name, source] of sources())
    assert.deepEqual(((await source.read('uncommitted', false, live)) as any).conflicted, ['src/a.ts'], name);
  // this Mac reads the status only for the uncommitted scope, the one that commits
  assert.deepEqual(((await localChangesSource('/repo').read('branch', false, live)) as any).conflicted, []);
  assert.equal(fake.callsTo('git.status').length, 2);
  // an older Host sends no field, and git's status can fail: no file is marked, as before
  hostDiff = async () => ({ value: { isRepo: true, patch: PATCH, truncated: false, unreadable: false } });
  status = async () => null;
  for (const [name, source] of sources()) assert.deepEqual(((await source.read('uncommitted', false, live)) as any).conflicted, [], name);
});

test('a folder that is no repository reads the same on both sources', async () => {
  info = async () => null;
  hostDiff = async () => ({ value: { isRepo: false } });
  for (const [name, source] of sources()) assert.deepEqual(await source.read('uncommitted', false, live), { kind: 'notRepo' }, name);
});

test('a read that fails says so: this Mac’s git rejects for the pane’s alert, the machine says why in a notice', async () => {
  localDiff = async () => {
    throw new Error('git broke');
  };
  await assert.rejects(localChangesSource('/repo').read('uncommitted', false, live), /git broke/);
  const machine = machineChangesSource(BOX, '/repo');
  hostDiff = async () => ({ error: { message: 'x', code: 'host_outdated' } });
  assert.deepEqual(await machine.read('uncommitted', false, live), {
    kind: 'notice',
    text: 'Update the Host on that machine.',
    hostId: BOX.id,
  });
  hostDiff = async () => ({ error: { message: 'x', code: 'read_timed_out' } });
  assert.deepEqual((await machine.read('uncommitted', false, live)) as any, {
    kind: 'notice',
    text: 'The machine took too long to read that folder.',
    hostId: BOX.id,
  });
  hostDiff = async () => ({ value: { isRepo: true, patch: '', truncated: false, unreadable: true } });
  assert.deepEqual(await machine.read('uncommitted', false, live), { kind: 'notice', text: 'The machine could not read the changes.' });
  hostDiff = async () => {
    throw new Error('the bridge failed');
  };
  assert.deepEqual(await machine.read('uncommitted', false, live), { kind: 'notice', text: 'Could not read that on the machine.' });
});

test('a patch the Host cut says so under the files it did send', async () => {
  hostDiff = async () => ({ value: { isRepo: true, patch: PATCH, truncated: true, unreadable: false } });
  const read = await machineChangesSource(BOX, '/repo').read('uncommitted', false, live);
  assert.deepEqual(read, {
    kind: 'files',
    root: '/repo',
    files: parseUnifiedDiff(PATCH),
    conflicted: [],
    cut: 'The patch is cut here; more changes are not shown.',
  });
});

test('a read the pane no longer wants says nothing, however it ends', async () => {
  let wanted = true;
  const gone = () => wanted;
  for (const [name, source] of sources()) {
    wanted = false;
    assert.equal(await source.read('uncommitted', false, gone), null, `${name}: answered after the pane moved on`);
  }
  // a failure that comes after the pane moved on is as silent as an answer
  hostDiff = async () => {
    throw new Error('late');
  };
  assert.equal(await machineChangesSource(BOX, '/repo').read('uncommitted', false, gone), null);
  // this Mac's git reads nothing more once the pane has moved on after finding the repository
  const reads = fake.callsTo('git.diff').length;
  assert.equal(await localChangesSource('/repo').read('uncommitted', false, gone), null);
  assert.equal(fake.callsTo('git.diff').length, reads);
});

test('both sources commit the same message and files, and discard the same file or everything', async () => {
  const files = [{ path: 'src/a.ts', oldPath: 'src/a.ts' }];
  for (const [, source] of sources()) {
    await source.commit('/repo', 'all of it', null);
    await source.commit('/repo', 'one of two', files);
    await source.discard('/repo', 'src/a.ts');
    await source.discard('/repo', null);
  }
  const local = fake.callsTo('git.commitFiles').map(([root, message, picked]) => ({ root, message, files: picked }));
  const machine = fake.callsTo('host.gitCommit').map(([, q]: any) => ({ root: q.path, message: q.message, files: q.files }));
  assert.deepEqual(local, machine);
  assert.deepEqual(machine, [
    { root: '/repo', message: 'all of it', files: null },
    { root: '/repo', message: 'one of two', files },
  ]);
  assert.deepEqual(
    fake.callsTo('host.gitDiscard').map(([, q]: any) => [q.path, q.file]),
    discards,
  );
  assert.deepEqual(discards, [
    ['/repo', 'src/a.ts'],
    ['/repo', null],
  ]);
});

test('a machine’s refusal reads as this Mac’s git failure does: words in stderr', async () => {
  const machine = machineChangesSource(BOX, '/repo');
  fake = fakeNative({ host: { gitCommit: async () => ({ error: { message: 'x', code: 'host_outdated' } }) } });
  installNative(fake);
  const refused = await machine.commit('/repo', 'm', null);
  assert.deepEqual(refused, { ok: false, stdout: '', stderr: 'Update the Host on that machine.', refused: true });
  // what a failed discard says: a refusal as it is, else git's first line, else a sentence of the pane's own
  assert.equal(machine.discardFailure('a', refused), 'Update the Host on that machine.');
  assert.equal(machine.discardFailure('a', { ok: false, stdout: '', stderr: 'error: x\nmore' }), 'error: x');
  assert.equal(machine.discardFailure(null, { ok: false, stdout: '', stderr: '' }), 'Could not discard changes');
  const here = localChangesSource('/repo');
  assert.equal(here.discardFailure('a', { ok: false, stdout: '', stderr: 'error: x\nmore' }), 'error: x');
  assert.equal(here.discardFailure('a', { ok: false, stdout: '', stderr: '' }), 'Could not discard file changes');
  assert.equal(here.discardFailure(null, { ok: false, stdout: '', stderr: '' }), 'Could not discard changes');
});

test('what the pane remembers is keyed by the machine: one path on two machines, or on this Mac, is three folders', () => {
  const keys = [
    localChangesSource('/srv/app').keyOf('/srv/app'),
    machineChangesSource(BOX, '/srv/app').keyOf('/srv/app'),
    machineChangesSource({ id: 'ssh:me@other', name: 'other' }, '/srv/app').keyOf('/srv/app'),
  ];
  assert.equal(new Set(keys).size, 3);
  assert.equal(keys[0], '/srv/app', 'this Mac keeps the plain path its marks were saved under');
  assert.equal(machineChangesSource(BOX, '/a').key === machineChangesSource(BOX, '/b').key, false);
  // a file is addressed by its absolute path here and by its path in the folder on a machine
  assert.equal(localChangesSource('/repo').pathOf('src/a.ts', '/repo'), '/repo/src/a.ts');
  assert.equal(machineChangesSource(BOX, '/repo').pathOf('src/a.ts', '/repo'), 'src/a.ts');
  assert.equal(localChangesSource('/repo').where, '');
  assert.equal(machineChangesSource(BOX, '/repo').where, ' on box');
});

test('capabilities: this Mac offers everything; a machine switches off exactly what it declares, each with its reason', () => {
  const all = localChangesSource('/repo').capabilities;
  assert.deepEqual(Object.values(all), Array(6).fill({ on: true }));
  const machine = machineChangesSource(BOX, '/repo').capabilities;
  assert.deepEqual(machine, machineCapabilities('box'));
  assert.deepEqual(Object.keys(machine).sort(), Object.keys(all).sort());
  // Last Turn is the Host's own: on, unless the machine's Host is older than this app
  const { lastTurn, ...off } = machine;
  assert.deepEqual(lastTurn, { on: true });
  for (const [name, cap] of Object.entries(off)) {
    assert.equal(cap.on, false, name);
    assert.match((cap as { reason: string }).reason, /box/, `${name} says which machine`);
  }
  assert.deepEqual(machineChangesSource({ ...BOX, stale: true }, '/repo').capabilities.lastTurn, {
    on: false,
    reason: "Update the Host on that machine to see a turn's changes",
  });
});

test('Last Turn on a machine reads the newest turn that changed files, and says when the Host has no start of the turn', async () => {
  const machine = machineChangesSource(BOX, '/repo');
  const read = (ids: string[], wanted = live) => machine.readTurn!(ids, wanted);
  // the Host is asked for the folder and the turn
  assert.deepEqual(await read(['t3']), { kind: 'files', root: '/repo', files: parseUnifiedDiff(PATCH), conflicted: [] });
  assert.deepEqual(fake.callsTo('host.gitTurnDiff').at(-1), [BOX.id, { path: '/repo', turnId: 't3' }]);
  // a turn that answered only (no change) is looked past: the newest one that changed files shows, as on this Mac
  const answers: Record<string, any> = {
    t3: { value: { isRepo: true, baseline: true, patch: '', truncated: false } },
    t2: { value: { isRepo: true, baseline: true, patch: '', truncated: false } },
    t1: { value: { isRepo: true, baseline: true, patch: PATCH, truncated: true } },
  };
  hostTurn = async (q) => answers[q.turnId];
  assert.deepEqual(await read(['t3', 't2', 't1']), {
    kind: 'files',
    root: '/repo',
    files: parseUnifiedDiff(PATCH),
    conflicted: [],
    cut: 'The patch is cut here; more changes are not shown.',
  });
  // no turn changed anything: no changes; a turn the Host has no start of, and nothing else to show: said so, scope still switchable
  hostTurn = async () => ({ value: { isRepo: true, baseline: true, patch: '', truncated: false } });
  assert.deepEqual(await read(['t3', 't2']), { kind: 'files', root: '/repo', files: [], conflicted: [] });
  hostTurn = async () => ({ value: { isRepo: true, baseline: false } });
  assert.deepEqual(await read(['t3']), { kind: 'notice', text: "This turn's baseline is gone. Uncommitted shows what has changed now." });
  assert.deepEqual(await read([]), { kind: 'files', root: '/repo', files: [], conflicted: [] }, 'a chat with no turn has none to show');
  // a turn the Host lost (it was running when the Host stopped) is not looked past: the older turn's edit is not its changes
  hostTurn = async (q) => answers[q.turnId];
  answers.t3 = { value: { isRepo: true, baseline: false } };
  assert.deepEqual(await read(['t3', 't2', 't1']), {
    kind: 'notice',
    text: "This turn's baseline is gone. Uncommitted shows what has changed now.",
  });
  // one with a baseline that changed nothing, then a lost one, then an older one with files: still the lost one's notice
  answers.t3 = { value: { isRepo: true, baseline: true, patch: '', truncated: false } };
  answers.t2 = { value: { isRepo: true, baseline: false } };
  assert.equal(((await read(['t3', 't2', 't1'])) as any).kind, 'notice');
  // only the newest few are looked at
  hostTurn = async () => ({ value: { isRepo: true, baseline: true, patch: '', truncated: false } });
  const asked = fake.callsTo('host.gitTurnDiff').length;
  await read(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.equal(fake.callsTo('host.gitTurnDiff').length - asked, 5);
  // no repository, a Host that refuses or is older, a failing bridge
  hostTurn = async () => ({ value: { isRepo: false } });
  assert.deepEqual(await read(['t3']), { kind: 'notRepo' });
  hostTurn = async () => ({ error: { message: 'x', code: 'host_outdated' } });
  assert.deepEqual(await read(['t3']), { kind: 'notice', text: 'Update the Host on that machine.', hostId: BOX.id });
  hostTurn = async () => {
    throw new Error('the bridge failed');
  };
  assert.deepEqual(await read(['t3']), { kind: 'notice', text: 'Could not read that on the machine.' });
  // a read the pane no longer wants says nothing, answered or failed
  assert.equal(await read(['t3'], () => false), null);
  hostTurn = async () => ({ value: { isRepo: true, baseline: true, patch: PATCH, truncated: false } });
  assert.equal(await read(['t3'], () => false), null);
});

test('Last Turn says how many big new files the Host left out, and a configuration git cannot read is the Host’s words', async () => {
  const machine = machineChangesSource(BOX, '/repo');
  const read = (ids: string[]) => machine.readTurn!(ids, live);
  hostTurn = async () => ({
    value: { isRepo: true, baseline: true, patch: PATCH, truncated: false, skipped: { count: 1, paths: ['big.bin'] } },
  });
  assert.equal(((await read(['t'])) as any).cut, '1 large untracked file is not shown.');
  hostTurn = async () => ({
    value: { isRepo: true, baseline: true, patch: PATCH, truncated: true, skipped: { count: 3, paths: ['a', 'b', 'c'] } },
  });
  assert.equal(
    ((await read(['t'])) as any).cut,
    'The patch is cut here; more changes are not shown. 3 large untracked files are not shown.',
  );
  // a turn that changed only such files is that turn's answer: no earlier turn is looked at
  hostTurn = async () => ({
    value: { isRepo: true, baseline: true, patch: '', truncated: false, skipped: { count: 2, paths: ['a', 'b'] } },
  });
  const asked = fake.callsTo('host.gitTurnDiff').length;
  assert.deepEqual(await read(['t2', 't1']), {
    kind: 'files',
    root: '/repo',
    files: [],
    conflicted: [],
    cut: '2 large untracked files are not shown.',
  });
  assert.equal(fake.callsTo('host.gitTurnDiff').length - asked, 1);
  // git on the machine could not read its configuration: the pane says so in the Host's words
  const words = 'Git on this machine could not read its configuration. Check its ~/.gitconfig and the repository’s .git/config.';
  hostDiff = async () => ({ error: { message: words, code: 'unavailable' } });
  assert.deepEqual(await machine.read('uncommitted', false, live), { kind: 'notice', text: words, hostId: BOX.id });
});
