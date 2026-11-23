// Live output reveal owns its originating view and retires stale probes, while manual output opens expose missing files.
import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, resetAll, impl } from './support/store-harness.ts';
import { deferred } from './support/async-scenarios.ts';

// where the chat runs: '' this Mac, a machine id, null not known yet
let place: string | null = '';
const realChats = await import('../src/lib/hostChats.ts');
mock.module('../src/lib/hostChats.ts', { namedExports: { ...realChats, hostOfChatNow: () => place } });
const { store, resetState } = await loadStore();
const { openSessionPane, openOutputFile } = await import('../src/store/outputs/pane.ts');
const { revealSessionOutputs } = await import('../src/store/outputReveal.ts');
const st = () => store.useStore.getState();
let turnNumber = 0;
const write = (path: string) => ({ path, deleted: false });
beforeEach(() => {
  resetState();
  resetAll();
  ++turnNumber;
  place = '';
  store.useStore.setState({
    route: { name: 'thread', id: 'a' },
    threads: { a: { id: 'a', cwd: '/repo' } as any },
    runtime: { a: { turns: [{ id: `t${turnNumber}`, status: 'inProgress', items: [] }] } as any },
    paneTabs: [],
    paneActive: '',
    diffPanel: { open: false },
    paneFull: true,
  });
  impl['fs.messagePath'] = async (path: string) => ({ path, kind: 'file' });
});
const reveal = (path: string) => revealSessionOutputs('a', `t${turnNumber}`, [write(path)]);

test('a fresh visual output opens beside its own chat; independent files get tabs, source files stay in Outputs', async () => {
  await reveal('/repo/a.html');
  await reveal('/repo/b.png');
  await reveal('/repo/source.ts');
  assert.deepEqual(
    st().paneTabs.map((t) => [t.path, t.ownerChat]),
    [
      ['/repo/a.html', 'a'],
      ['/repo/b.png', 'a'],
    ],
  );
  assert.equal(st().paneFull, false);
  assert.equal(st().paneActive, st().paneTabs[1].id);
});

test('updates refresh an existing file behind the selected tab and never reopen a closed tab or pane', async () => {
  await reveal('/repo/a.html');
  const original = st().paneTabs[0];
  store.openPaneTab('files');
  const active = st().paneActive;
  await reveal('/repo/a.html');
  assert.equal(st().paneActive, active);
  assert.notEqual(st().paneTabs[0].version, original.version);
  store.useStore.setState({ diffPanel: { open: false } });
  await reveal('/repo/a.html');
  assert.equal(st().diffPanel.open, false);
  store.closePaneTab(original.id);
  await reveal('/repo/a.html');
  assert.equal(
    st().paneTabs.some((t) => t.path === original.path),
    false,
  );
});

test('a replaced probe cannot reveal or refresh after newer work resolves first', async () => {
  const old = deferred<any>();
  impl['fs.messagePath'] = (p: string) => (p.endsWith('old.pdf') ? old.promise : Promise.resolve({ path: p, kind: 'file' }));
  const pending = reveal('/repo/old.pdf');
  await reveal('/repo/new.pdf');
  old.resolve({ path: '/repo/old.pdf', kind: 'file' });
  await pending;
  assert.deepEqual(
    st().paneTabs.map((t) => t.path),
    ['/repo/new.pdf'],
  );
});

test('navigation, user pane actions, harness replacement, a newer turn and undo retire pending automatic reveals', async () => {
  for (const invalidate of [
    () => store.useStore.setState({ route: { name: 'home' } }),
    () => store.openPaneTab('files'),
    () => store.useStore.setState({ segments: { a: [{ harness: 'claude', nativeId: 'replacement' }] } as any }),
    () => store.useStore.setState({ runtime: { a: { turns: [{ id: 'newer', items: [] }] } } as any }),
    () => store.useStore.setState({ runtime: { a: { turns: [{ id: `t${turnNumber}`, items: [], undone: true }] } } as any }),
  ]) {
    const original = st();
    store.useStore.setState({
      route: { name: 'thread', id: 'a' },
      runtime: { a: { turns: [{ id: `t${turnNumber}`, items: [] }] } } as any,
      paneTabs: [],
      paneActive: '',
      diffPanel: { open: false },
    });
    const probe = deferred<any>();
    impl['fs.messagePath'] = () => probe.promise;
    const pending = reveal('/repo/candidate.mp4');
    invalidate();
    probe.resolve({ path: '/repo/candidate.mp4', kind: 'file' });
    await pending;
    assert.equal(
      st().paneTabs.some((t) => t.kind === 'file'),
      false,
    );
    store.useStore.setState({ segments: original.segments });
  }
});

test('missing files, directories, rejected probes, background chats and retired turns never open a preview', async () => {
  for (const result of [null, { path: '/repo/folder.html', kind: 'dir' }]) {
    impl['fs.messagePath'] = async () => result;
    await reveal('/repo/a.html');
  }
  impl['fs.messagePath'] = async () => {
    throw Error('gone');
  };
  await reveal('/repo/a.html');
  await revealSessionOutputs('b', 'not-current', [write('/repo/a.html')]);
  await revealSessionOutputs('a', 'retired', [write('/repo/a.html')]);
  store.useStore.setState({ threads: {} });
  await reveal('/repo/a.html');
  assert.deepEqual(st().paneTabs, []);
});

test('manual output opening reports missing files and failures, but navigation retires a successful probe', async () => {
  await openOutputFile('a', '/repo/a.pdf');
  assert.equal(st().paneTabs[0].path, '/repo/a.pdf');
  impl['fs.messagePath'] = async () => null;
  await openOutputFile('a', '/repo/gone.pdf');
  assert.match(st().toasts.at(-1)!.text, /no longer available/);
  impl['fs.messagePath'] = async () => {
    throw Error('offline');
  };
  await openOutputFile('a', '/repo/gone.pdf');
  assert.match(st().toasts.at(-1)!.text, /offline/);
  const probe = deferred<any>();
  impl['fs.messagePath'] = () => probe.promise;
  const pending = openOutputFile('a', '/repo/late.pdf');
  store.useStore.setState({ route: { name: 'home' } });
  probe.resolve({ path: '/repo/late.pdf', kind: 'file' });
  await pending;
  assert.equal(st().paneTabs.length, 1);
});

test('Outputs and Usage are distinct per-chat tabs with a stable identity through harness aliases', () => {
  openSessionPane('a', 'outputs');
  openSessionPane('a', 'usage');
  openSessionPane('a', 'outputs');
  assert.equal(st().paneTabs.length, 2);
  assert.equal(st().paneTabs[0].id, st().paneActive);
  openSessionPane('background', 'usage');
  assert.equal(st().paneTabs.length, 2);
  store.useStore.setState({ segments: { a: [{ harness: 'claude', nativeId: 'native-a' }] } as any });
  openSessionPane('native-a', 'usage');
  assert.equal(st().paneTabs.length, 2);
  assert.equal(st().paneTabs[1].id, st().paneActive);
});

test('an explicit side-chat output opens in that chat’s pane without becoming owned by its parent', async () => {
  store.useStore.setState({
    threads: { ...st().threads, b: { id: 'b', cwd: '/side' } as any },
    paneTabs: [{ id: 'side', kind: 'chat', threadId: 'b' }],
  });
  await openOutputFile('b', '/side/report.pdf');
  assert.equal(st().paneTabs.at(-1)?.ownerChat, 'b');
  assert.equal(st().paneTabs.at(-1)?.path, '/side/report.pdf');
});

test('a manual output probe cannot override a newer tab selection or a later manual output request', async () => {
  store.openPaneTab('files');
  store.openPaneTab('changes');
  const probe = deferred<any>();
  impl['fs.messagePath'] = () => probe.promise;
  const pending = openOutputFile('a', '/repo/late.pdf');
  store.useStore.setState({ paneActive: 'files' });
  probe.resolve({ path: '/repo/late.pdf', kind: 'file' });
  await pending;
  assert.equal(st().paneActive, 'files');
  const old = deferred<any>();
  impl['fs.messagePath'] = (p: string) => (p.endsWith('old.pdf') ? old.promise : Promise.resolve({ path: p, kind: 'file' }));
  const first = openOutputFile('a', '/repo/old.pdf');
  await openOutputFile('a', '/repo/new.pdf');
  old.resolve({ path: '/repo/old.pdf', kind: 'file' });
  await first;
  assert.equal(st().paneTabs.find((t) => t.id === st().paneActive)?.path, '/repo/new.pdf');
});

test('reused turn ids on a replacement native segment do not inherit a closed output’s earlier reveal mark', async () => {
  await reveal('/repo/report.pdf');
  store.closePaneTab(st().paneActive);
  await reveal('/repo/report.pdf');
  assert.equal(st().paneTabs.length, 0);
  store.useStore.setState({ segments: { a: [{ harness: 'claude', nativeId: 'replacement' }] } as any });
  await reveal('/repo/report.pdf');
  assert.equal(st().paneTabs[0].path, '/repo/report.pdf');
});

test('equivalent Windows spellings share an output tab and keep it closed after dismissal', async () => {
  store.useStore.setState({ threads: { a: { id: 'a', cwd: 'C:\\repo' } as any } });
  await reveal('C:\\repo\\Report.pdf');
  const original = st().paneTabs[0];
  await reveal('c:/repo/report.pdf');
  assert.equal(st().paneTabs.length, 1);
  assert.equal(st().paneTabs[0].path, original.path, 'retain the exact path that owns any editor draft');
  await openOutputFile('a', 'c:/repo/report.pdf');
  assert.equal(st().paneTabs.length, 1);
  store.closePaneTab(original.id);
  await reveal('c:/repo/report.pdf');
  assert.equal(st().paneTabs.length, 0);
});

test('closing an existing preview during its first observed update keeps it closed on later updates', async () => {
  store.openPaneTab('file', { path: '/repo/manual.pdf' });
  const wait = deferred<any>();
  impl['fs.messagePath'] = () => wait.promise;
  const pending = reveal('/repo/manual.pdf');
  store.closePaneTab(st().paneActive);
  wait.resolve({ path: '/repo/manual.pdf', kind: 'file' });
  await pending;
  impl['fs.messagePath'] = async (path: string) => ({ path, kind: 'file' });
  await reveal('/repo/manual.pdf');
  assert.equal(st().paneTabs.length, 0);
});

test('a large output burst caps automatic tabs while the remaining files stay available in the inventory', async () => {
  const writes = Array.from({ length: 501 }, (_, i) => write(`/repo/burst-${i}.pdf`));
  await revealSessionOutputs('a', `t${turnNumber}`, writes);
  assert.equal(st().paneTabs.length, 500);
  store.closePaneTab(st().paneTabs[0].id);
  await revealSessionOutputs('a', `t${turnNumber}`, writes);
  assert.equal(st().paneTabs.length, 499, 'a capped burst never reopens closed tabs or starts untracked automatic tabs');
});

test('requests and reveal retention across many chats remain bounded; an evicted probe cannot regain ownership', async () => {
  const wait = deferred<void>();
  impl['fs.messagePath'] = async (path: string) => {
    await wait.promise;
    return { path, kind: 'file' };
  };
  const pending: Promise<void>[] = [];
  let first: any;
  for (let i = 0; i < 201; i++) {
    const id = `many-${i}`;
    store.useStore.setState({
      route: { name: 'thread', id },
      threads: { [id]: { id, cwd: '/repo' } as any },
      runtime: { [id]: { turns: [{ id: 't', items: [] }] } as any },
    });
    if (!first) first = st();
    pending.push(revealSessionOutputs(id, 't', [write('/repo/held.pdf')]));
  }
  store.useStore.setState(first);
  wait.resolve();
  await Promise.all(pending);
  assert.deepEqual(st().paneTabs, []);
});

test('a projectless chat can open an absolute output; a later folder selection retires its pending probe', async () => {
  store.useStore.setState({ threads: { a: { id: 'a', cwd: null } } as any });
  impl['fs.messagePath'] = async () => ({ path: '/tmp/report.pdf', kind: 'file' });
  await openOutputFile('a', '/tmp/report.pdf');
  assert.equal(st().paneTabs.at(-1)?.path, '/tmp/report.pdf');
  const wait = deferred<any>();
  impl['fs.messagePath'] = () => wait.promise;
  const pending = openOutputFile('a', '/tmp/other.pdf');
  store.useStore.setState({ threads: { a: { id: 'a', cwd: '/new' } } as any });
  wait.resolve({ path: '/tmp/other.pdf', kind: 'file' });
  await pending;
  assert.equal(
    st().paneTabs.some((t) => t.path === '/tmp/other.pdf'),
    false,
  );
});

const hostCwd = 'host:box\n/srv/app';
const hostRead = (okPaths: string[]) => {
  const asked: string[] = [];
  impl['host.fsRead'] = async (_id: string, q: { path: string; limit: number }) => (
    asked.push(`${q.path}:${q.limit}`),
    okPaths.includes(q.path) ? { value: { kind: 'text', text: '', size: 0, truncated: false } } : { error: { message: 'gone' } }
  );
  return asked;
};
const onBox = () => {
  place = 'box';
  store.useStore.setState({ threads: { a: { id: 'a', cwd: '/srv/app' } as any } });
  impl['fs.messagePath'] = async () => assert.fail('this Mac was asked');
};

test('a chat on a machine reveals its visual output through the Host file read, once, and refreshes it on a later write', async () => {
  onBox();
  const asked = hostRead(['/srv/app/out/a.html']);
  await reveal('out/a.html');
  assert.deepEqual(asked, ['/srv/app/out/a.html:1']);
  assert.deepEqual(
    st().paneTabs.map((t) => [t.path, t.cwd, t.ownerChat]),
    [['/srv/app/out/a.html', hostCwd, 'a']],
  );
  const first = st().paneTabs[0];
  await reveal('/srv/app/out/a.html');
  assert.equal(st().paneTabs.length, 1);
  assert.notEqual(st().paneTabs[0].version, first.version);
  await reveal('/srv/app/missing.png');
  await reveal('~/x.png');
  assert.equal(st().paneTabs.length, 1);
});

test('the Outputs list opens a machine file in the same file tab, and says when it is gone', async () => {
  onBox();
  hostRead(['/srv/app/r.pdf']);
  await openOutputFile('a', '/srv/app/r.pdf');
  assert.deepEqual([st().paneTabs.at(-1)?.path, st().paneTabs.at(-1)?.cwd], ['/srv/app/r.pdf', hostCwd]);
  await openOutputFile('a', '/srv/app/gone.pdf');
  assert.match(st().toasts.at(-1)!.text, /no longer available/);
  await openOutputFile('a', '~/r.pdf');
  assert.match(st().toasts.at(-1)!.text, /no longer available/);
});

test('a chat whose place is not known yet reads nothing on this Mac and says so', async () => {
  place = null;
  impl['fs.messagePath'] = async () => assert.fail('this Mac was asked');
  await reveal('/repo/a.html');
  await openOutputFile('a', '/repo/a.html');
  assert.deepEqual(st().paneTabs, []);
  assert.match(st().toasts.at(-1)!.text, /Still finding/);
});
