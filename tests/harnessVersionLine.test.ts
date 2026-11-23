// src/components/harness/HarnessVersionLine.tsx (with the real src/harness/harnessUpdates.ts store and
// UpdateAvailable): the version line on a harness's page, its update pill, the running-chat question, the update's
// terminal and Stop, what came of it, and the picker's quiet note.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { render, click, byText, maybeText } from './support/pages-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, act } = await import('react');
const calls: any[] = [];
let updateResult: any = { ok: true };
let updateThrows: unknown = null;
let recheckFails = false;
let stateCb: ((s: any) => void) | null = null;
let checkAnswer = (): any => ({ harnesses: [], all: null, checkedAt: 5, checking: false });
let stateAnswer: any = Promise.resolve({ harnesses: [], all: null, checkedAt: null, checking: false });
installNativeStub({
  harnessUpdates: {
    state: () => stateAnswer,
    onState: (cb: any) => ((stateCb = cb), () => undefined),
    check: async (force: boolean) => (calls.push(['check', force]), checkAnswer()),
    update: async (kind: string, when?: string) => {
      calls.push(['update', kind, when]);
      if (updateThrows) throw updateThrows;
      return updateResult;
    },
    cancelWait: async (kind: string) => calls.push(['cancelWait', kind]),
  },
  harnessRuns: { stop: async (id: string) => calls.push(['stop', id]) },
});
stubStore({
  toast: (...a: any[]) => calls.push(['toast', ...a]),
  toastFailure: (message: string) => (error: Error) => calls.push(['recheck-error', message, error.message]),
});
mock.module('../src/session/clipboard.ts', { namedExports: { copyText: (t: string, done: string) => calls.push(['copy', t, done]) } });
const { create } = await import('zustand');
const runs = create<any>(() => ({ runs: [] }));
mock.module('../src/session/harness/harnessRuns.ts', {
  namedExports: {
    useHarnessRuns: runs,
    runTransport: (id: string) => `transport:${id}`,
    recheckHarness: async (kind: string) => {
      calls.push(['recheck', kind]);
      if (recheckFails) throw new Error('probe failed');
    },
  },
});
mock.module('../src/components/panels/TerminalPanel.tsx', {
  namedExports: {
    TermView: ({ tab, transport, onExit }: any) => h('div', { 'data-term': tab.id, 'data-transport': transport, onClick: onExit }),
  },
});
const { HarnessVersionLine, sourceLine } = await import('../src/components/harness/HarnessVersionLine.tsx');
const { INSTALL_SOURCE_CASES } = await import('./support/install-source-cases.ts');
const { UpdateAvailable } = await import('../src/components/harness/UpdateAvailable.tsx');
const store = await import('../src/harness/harnessUpdates.ts');

const info = (o: any = {}) => ({
  harness: 'claude',
  bin: '/u/.local/bin/claude',
  installed: '2.1.296',
  latest: '2.1.302',
  via: 'self',
  from: 'standalone install',
  command: 'claude update',
  updatable: true,
  blockedReason: null,
  latestStatus: 'unverified',
  checkedAt: 1,
  state: 'idle',
  waitingFor: 0,
  runId: null,
  outcome: null,
  ...o,
});
const set = (harnesses: any[], extra: any = {}) =>
  act(async () => store.useHarnessUpdates.setState({ harnesses, all: null, checkedAt: 1, checking: false, ...extra }));
const binary = { bin: '/u/.local/bin/claude', manual: null };
const view = () => render(h(HarnessVersionLine, { kind: 'claude', label: 'Claude Code', binary }));
const line = (host: HTMLElement) => host.querySelector('.hver-line')!.textContent;

test('the line under the version says where it is from and how it updates, or why not', () => {
  assert.equal(sourceLine(info() as any, 'Native installer'), 'Updates with claude update');
  assert.equal(sourceLine(info({ updatable: false, latest: '2.1.296' }) as any, 'Native installer'), 'Up to date · Native installer');
  assert.equal(
    sourceLine(info({ updatable: false, latest: null }) as any, 'Native installer'),
    "Native installer · couldn't check for a newer version",
  );
  assert.equal(
    sourceLine(info({ blockedReason: 'app-bundle', via: 'app-bundle', from: 'Claude.app' }) as any, 'Bundled with Claude.app'),
    'Bundled with Claude.app: updates with the app',
  );
  assert.equal(
    sourceLine(info({ blockedReason: 'version-manager', from: 'a version manager' }) as any, 'Native installer'),
    'Native installer: update it with your version manager',
  );
  assert.equal(
    sourceLine(info({ blockedReason: 'needs-admin', command: 'npm i -g x' }) as any, 'Native installer'),
    'Needs admin rights: run npm i -g x yourself',
  );
  assert.equal(
    sourceLine(info({ blockedReason: 'unknown-install' }) as any, 'Native installer'),
    'Native installer: update it the way you installed it',
  );
  assert.equal(
    sourceLine(info({ updatable: false, latestStatus: 'knownBad' }) as any, 'Native installer'),
    "2.1.302 is out but doesn't work with MoPilot yet",
  );
  assert.equal(
    sourceLine(info({ updatable: false, latestStatus: 'tooOld' }) as any, 'Native installer'),
    "2.1.302 is out but doesn't work with MoPilot yet",
  );
  // a known-bad newest that is what's installed is just up to date
  assert.equal(
    sourceLine(info({ updatable: false, latestStatus: 'knownBad', installed: '2.1.302' }) as any, 'Native installer'),
    'Up to date · Native installer',
  );
});

test('manual package updates retain Copy and Re-check without offering an unavailable automatic update', async () => {
  calls.length = 0;
  await set([info({ blockedReason: 'manual-terminal', updatable: false })]);
  const v = await view();
  assert.match(line(v.host)!, /Run the update command in your terminal, then re-check/);
  assert.equal(v.host.querySelector('.hver-pill'), null);
  await click(byText(v.host, 'Copy'));
  assert.ok(calls.some((call) => call[0] === 'copy' && call[1] === 'claude update'));
  await click(byText(v.host, 'Re-check'));
  assert.ok(calls.some((call) => call[0] === 'recheck' && call[1] === 'claude'));
  assert.ok(calls.some((call) => call[0] === 'check' && call[1] === true));
  await set([info({ blockedReason: 'manual-terminal', updatable: false })]);
  recheckFails = true;
  await click(byText(v.host, 'Re-check'));
  recheckFails = false;
  assert.ok(calls.some((call) => call[0] === 'recheck-error' && call[2] === 'probe failed'));
  await v.unmount();
  calls.length = 0;
});

test('manual and administrator-only updates retain incompatibility warnings and never recommend a disallowed latest', async (t) => {
  for (const blockedReason of ['manual-terminal', 'needs-admin'])
    for (const latestStatus of ['knownBad', 'tooOld']) {
      await set([info({ blockedReason, latestStatus, updatable: false })]);
      const v = await view();
      t.after(() => v.unmount());
      assert.match(v.host.textContent!, /2.1.302 is out but doesn't work with MoPilot yet/);
      assert.equal(maybeText(v.host, 'Copy'), null);
      assert.equal(v.host.querySelector('.hver-pill'), null);
      await v.unmount();
    }
  calls.length = 0;
});

test('nothing for a harness main has no version for; the version and the update pill, which updates', async () => {
  await set([]);
  const none = await view();
  assert.equal(none.host.innerHTML, '');
  await none.unmount();
  await set([info()]);
  const v = await view();
  assert.equal(v.host.querySelector('.hver-version')!.textContent, '2.1.296');
  const pill = byText(v.host, 'Update to 2.1.302');
  assert.equal(pill.getAttribute('aria-label'), 'Update Claude Code from 2.1.296 to 2.1.302');
  // what updates it and from which version to which; no tested / not yet tested word
  assert.equal(pill.title, 'Updates with claude update\nFrom 2.1.296 → 2.1.302');
  assert.equal(v.host.querySelector('.hver-sub')!.getAttribute('title'), '/u/.local/bin/claude');
  await click(pill);
  assert.deepEqual(calls.splice(0), [['update', 'claude', undefined]]);
  await set([info({ installed: null, latest: '2.1.295' })]);
  assert.equal(v.host.querySelector('.hver-version')!.textContent, 'Version unknown');
  assert.equal(byText(v.host, 'Update to').title, 'Updates with claude update\nFrom null → 2.1.295');
  await v.unmount();
  // where the page already says the version, only how it updates
  const bare = await render(h(HarnessVersionLine, { kind: 'claude', label: 'Claude Code', binary, version: false }));
  assert.equal(bare.host.querySelector('.hver-version'), null);
  assert.ok(byText(bare.host, 'Update to 2.1.295'));
  await bare.unmount();
});

test('with chats mid-turn it asks first: Update when idle, Update now, or Cancel', async () => {
  await set([info()]);
  const v = await view();
  updateResult = {
    ok: false,
    error: 'chats',
    chats: [
      { id: 'a', title: 'Fix login' },
      { id: 'b', title: 'Refactor store' },
    ],
  };
  await click(byText(v.host, 'Update to'));
  const ask = v.host.querySelector('.hver-ask') as HTMLElement;
  assert.equal(ask.getAttribute('aria-label'), 'Update Claude Code now?');
  assert.match(
    ask.textContent!,
    /2 chats are working with it: "Fix login", "Refactor store"\. They'll restart on 2\.1\.302 when their turn ends\./,
  );
  updateResult = { ok: true, waiting: true };
  await click(byText(ask, 'Update when idle'));
  assert.equal(v.host.querySelector('.hver-ask'), null);
  updateResult = {
    ok: false,
    error: 'chats',
    chats: [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
      { id: 'c', title: 'C' },
      { id: 'd', title: 'D' },
    ],
  };
  await click(byText(v.host, 'Update to'));
  assert.match(v.host.querySelector('.hver-ask')!.textContent!, /4 chats are working with it: "A", "B", "C", …\./);
  updateResult = { ok: true };
  await click(byText(v.host, 'Update now'));
  updateResult = { ok: false, error: 'chats' };
  await click(byText(v.host, 'Update to'));
  assert.match(v.host.querySelector('.hver-ask')!.textContent!, /0 chats are working with it: \./);
  await click(byText(v.host, 'Cancel'));
  updateResult = { ok: false, error: 'chats', chats: [{ id: 'a', title: 'A' }] };
  await click(byText(v.host, 'Update to'));
  assert.match(v.host.querySelector('.hver-ask')!.textContent!, /1 chat is working with it: "A"\./);
  assert.deepEqual(
    calls.splice(0).map((c) => c[2]),
    [undefined, 'idle', undefined, 'now', undefined, undefined],
  );
  await v.unmount();
});

test('a refused or failed update says why', async () => {
  await set([info()]);
  const v = await view();
  for (const r of [
    { ok: false, error: 'busy', by: 'codex' },
    { ok: false, error: 'spawn', message: 'no pty' },
    { ok: false, error: 'not-updatable' },
  ]) {
    updateResult = r;
    await click(byText(v.host, 'Update to'));
  }
  updateThrows = new Error('IPC down');
  await click(byText(v.host, 'Update to'));
  updateThrows = null;
  updateResult = { ok: true };
  assert.deepEqual(
    calls.splice(0).filter((c) => c[0] === 'toast'),
    [
      // the lock's installer, not its code ("self")
      ['toast', "Another update is running. Try again once it's done.", 'error'],
      ['toast', "Couldn't update Claude Code: no pty", 'error'],
      ['toast', "Couldn't update Claude Code", 'error'],
      ['toast', "Couldn't update Claude Code: IPC down", 'error'],
    ],
  );
  await v.unmount();
});

test('waiting for chats: the pill counts them and cancels; updating: the terminal of the run and Stop; a quiet run shows none', async () => {
  await set([info({ state: 'waiting', waitingFor: 2 })]);
  const v = await view();
  await click(byText(v.host, 'Waiting for 2 chats · Cancel'));
  await set([info({ state: 'waiting', waitingFor: 1 })]);
  assert.ok(byText(v.host, 'Waiting for 1 chat · Cancel'));
  await act(async () => runs.setState({ runs: [{ id: 'r1', state: 'running', quiet: false, command: 'claude update' }] }));
  await set([info({ state: 'updating', runId: 'r1' })]);
  assert.ok(v.host.querySelector('.hver-pill.busy'));
  assert.equal(maybeText(v.host, 'Update to'), null);
  assert.equal(v.host.querySelector('[data-term]')!.getAttribute('data-transport'), 'transport:r1');
  // the run's end comes from main's run list, not the terminal
  await click(v.host.querySelector('[data-term]'));
  await click(byText(v.host, 'Stop'));
  assert.deepEqual(calls.splice(0), [
    ['cancelWait', 'claude'],
    ['stop', 'r1'],
  ]);
  await act(async () => runs.setState({ runs: [{ id: 'r1', state: 'running', quiet: true, command: 'claude update' }] }));
  assert.equal(v.host.querySelector('[data-term]'), null, 'Update all runs quietly');
  await v.unmount();
});

test('what came of it: updated; still old with Retry; failed or broken with output and the command', async () => {
  await act(async () => runs.setState({ runs: [{ id: 'r1', state: 'exited', quiet: false, command: 'claude update' }] }));
  await set([
    info({
      updatable: false,
      latest: '2.1.302',
      installed: '2.1.302',
      outcome: { result: 'updated', from: '2.1.296', to: '2.1.302', message: 'Updated from 2.1.296', runId: 'r1' },
    }),
  ]);
  const v = await view();
  assert.equal(v.host.querySelector('.install-outcome.ok')!.textContent, 'Updated from 2.1.296');
  assert.equal(maybeText(v.host, 'Show output'), null);
  await set([info({ outcome: { result: 'unchanged', message: 'Still 2.1.296 after claude update; 2.1.302 is out', runId: 'r1' } })]);
  await click(byText(v.host, 'Retry'));
  assert.equal(v.host.querySelector('[data-term]'), null);
  await click(byText(v.host, 'Show output'));
  assert.equal(v.host.querySelector('[data-term]')!.getAttribute('data-term'), 'r1');
  await set([info({ outcome: { result: 'failed', message: "Didn't update: EACCES", runId: 'r1' } })]);
  await click(byText(v.host, 'Copy command'));
  await set([info({ command: null, outcome: { result: 'broken', message: "Updated but won't start", runId: 'gone' } })]);
  assert.equal(maybeText(v.host, 'Copy command'), null);
  assert.equal(maybeText(v.host, 'Show output'), null, 'no run to show');
  // an outcome is shown only once the row is idle again
  await set([info({ state: 'updating', outcome: { result: 'failed', message: 'x' } })]);
  assert.equal(v.host.querySelector('.install-outcome'), null);
  assert.deepEqual(calls.splice(0), [
    ['update', 'claude', undefined],
    ['copy', 'claude update', 'Copied command'],
  ]);
  await v.unmount();
});

test('needs admin rights: the command to run yourself, with Copy', async () => {
  await set([info({ updatable: false, blockedReason: 'needs-admin', command: 'npm install -g --prefix /usr/local x@latest' })]);
  const v = await view();
  assert.match(line(v.host)!, /Needs admin rights: run npm install -g --prefix \/usr\/local x@latest yourself/);
  await click(byText(v.host, 'Copy'));
  assert.deepEqual(calls.splice(0), [['copy', 'npm install -g --prefix /usr/local x@latest', 'Copied command']]);
  await set([info({ updatable: false, blockedReason: 'needs-admin', command: null })]);
  assert.equal(maybeText(v.host, 'Copy'), null);
  await v.unmount();
});

test("the picker's note: only an update on offer, while nothing runs", async () => {
  const r = await render(h(UpdateAvailable, { kind: 'claude' }));
  await set([info()]);
  assert.equal(r.host.textContent, 'Update available: 2.1.302');
  await set([info({ state: 'updating' })]);
  assert.equal(r.host.textContent, '');
  await set([info({ updatable: false })]);
  assert.equal(r.host.textContent, '');
  await set([]);
  assert.equal(r.host.textContent, '');
  await r.unmount();
});

test('the store follows main: its answer and pushes, never anything but a state; checks ask main; how many have updates', async () => {
  store.useHarnessUpdates.setState({ harnesses: [], all: null, checkedAt: null, checking: false });
  stateAnswer = Promise.resolve({ harnesses: [info()], all: null, checkedAt: 2, checking: false });
  store.followHarnessUpdates();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.useHarnessUpdates.getState().checkedAt, 2);
  stateCb!({ harnesses: [info(), info({ harness: 'codex' })], all: null, checkedAt: 3, checking: false });
  assert.equal(store.updatableCount(store.useHarnessUpdates.getState()), 2);
  stateCb!(undefined as any);
  stateCb!({ nope: true } as any);
  assert.equal(store.useHarnessUpdates.getState().checkedAt, 3);
  await store.checkHarnessUpdates(true);
  assert.equal(store.useHarnessUpdates.getState().checkedAt, 5);
  assert.deepEqual(calls.splice(0), [['check', true]]);
  // a failing read is only noted
  stateAnswer = Promise.reject(new Error('gone'));
  store.followHarnessUpdates();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.useHarnessUpdates.getState().checkedAt, 5);
});

test('the header names the install as its Version row does, from the same binary, installs and path set', async () => {
  for (const c of INSTALL_SOURCE_CASES) {
    await set([info({ bin: c.bin, installed: '2.1.302', latest: '2.1.302', updatable: false, ...c.check })]);
    const v = await render(
      h(HarnessVersionLine, { kind: 'claude', label: 'Claude Code', binary: { bin: c.bin, installs: c.installs, manual: c.manual } }),
    );
    assert.equal(v.host.querySelector('.hver-sub')!.textContent, c.line, c.name);
    assert.ok(c.line.includes(c.words), c.name);
    await v.unmount();
  }
});

test("main's check of another binary says nothing, and is asked once to check the one chats run", async () => {
  // the user just chose a custom location while a check of the native install is under way
  await set([info({ updatable: false, latest: '2.1.296' })], { checking: true });
  const custom = { bin: '/s/wrapper.sh', installs: [], manual: '/s/wrapper.sh' };
  const v = await render(h(HarnessVersionLine, { kind: 'claude', label: 'Claude Code', binary: custom }));
  assert.equal(v.host.innerHTML, '');
  // that check's answer may predate the choice: the line asks only once it is over
  assert.deepEqual(calls.splice(0), []);
  const stale = [info({ updatable: false, latest: '2.1.296' })];
  const fresh = [info({ bin: '/s/wrapper.sh', via: 'unknown', from: null, updatable: false, blockedReason: 'unknown-install' })];
  checkAnswer = () => ({ harnesses: fresh, all: null, checkedAt: 6, checking: false });
  await set(stale);
  assert.deepEqual(calls.splice(0), [['check', false]]);
  assert.match(v.host.querySelector('.hver-sub')!.textContent!, /^Custom location: /);
  // the same binary chosen again later asks again; a fresh answer that still names another binary isn't asked for again
  checkAnswer = () => ({ harnesses: stale, all: null, checkedAt: 7, checking: false });
  await set(stale);
  assert.deepEqual(calls.splice(0), [['check', false]]);
  await set(stale, { checkedAt: 8 });
  assert.equal(v.host.innerHTML, '');
  assert.deepEqual(calls.splice(0), []);
  await v.unmount();
  checkAnswer = () => ({ harnesses: [], all: null, checkedAt: 5, checking: false });
  // a page that doesn't know which binary runs yet (Codex's installs still being read) waits without asking
  const unknown = await render(h(HarnessVersionLine, { kind: 'claude', label: 'Claude Code', binary: { bin: null, manual: null } }));
  assert.equal(unknown.host.innerHTML, '');
  assert.deepEqual(calls.splice(0), []);
  await unknown.unmount();
});

test('an older main that names no installer still reads as installed manually', async () => {
  await set([info({ via: undefined, from: '/private/unknown', updatable: false, latest: '2.1.296' })]);
  const v = await view();
  assert.equal(v.host.querySelector('.hver-sub')!.textContent, 'Up to date · Installed manually');
  await v.unmount();
});
