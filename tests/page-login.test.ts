import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { render, click, byText, flush } from './support/pages-kit.ts';
import { stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const calls: any[] = [];
let status: any = { state: 'ready' };
let restartFails = false;
// the store's restartCodex: main restarts Codex's app-server, then the window connects to it
stubStore({
  restartCodex: async () => {
    calls.push(['restart']);
    if (restartFails) throw new Error('no codex binary');
    calls.push(['connect']);
  },
  toastFailure: (what: string) => (e: Error) => calls.push(['failed', what, e.message]),
  toast: (text: string, kind: string) => calls.push(['toast', text, kind]),
});
mock.module('../src/session/open.ts', { namedExports: { openLink: (u: string) => calls.push(['open', u]) } });
mock.module('../src/session/clipboard.ts', { namedExports: { copyText: (command: string) => calls.push(['copy', command]) } });
mock.module('../src/session/harness/select.ts', { namedExports: { useHarnessStatus: (h: string) => (calls.push(['status', h]), status) } });
mock.module('../src/harness/registry.ts', {
  namedExports: {
    harnessInfo: (h: string) => ({ install: { docs: `https://install/${h}` }, versions: { min: '0.162.0', knownBad: [], tested: [] } }),
  },
});
let version: any = null;
let updateFails = false;
let updateResult: any = { ok: true };
mock.module('../src/harness/harnessUpdates.ts', { namedExports: { useVersionOf: () => version } });
installNativeStub({
  harnessUpdates: {
    update: async (...a: any[]) => {
      calls.push(['update', ...a]);
      if (updateFails) throw new Error('IPC down');
      return updateResult;
    },
  },
});
mock.module('../src/components/harnessPicker/HarnessPicker.tsx', {
  namedExports: { signInHarness: (h: string) => calls.push(['signin', h]) },
});
const { createElement } = await import('react');
const { CodexNotice, NeedsCodex, useCodexFix } = await import('../src/components/pages/Login.tsx');

test('an outdated Codex keeps a manual update recovery when automatic execution is unavailable', async () => {
  calls.length = 0;
  version = { state: 'idle', updatable: false, blockedReason: 'manual-terminal', command: 'codex update' };
  status = { state: 'error', version: '0.147.0' };
  const v = await render(createElement(NeedsCodex, { what: 'Continue.' }));
  assert.match(v.host.textContent!, /Run the update command in your terminal, then restart MoPilot/);
  await click(byText(v.host, 'Copy update command'));
  assert.ok(calls.some((call) => call[0] === 'copy' && call[1] === 'codex update'));
  assert.equal(
    calls.some((call) => call[0] === 'update' || call[0] === 'restart'),
    false,
  );
  await v.unmount();
  version = null;
  status = { state: 'ready' };
});

test('the manual Codex recovery never recommends a known-bad or too-old replacement', async (t) => {
  t.after(() => {
    version = null;
    status = { state: 'ready' };
  });
  for (const latestStatus of ['knownBad', 'tooOld']) {
    version = { state: 'idle', updatable: false, blockedReason: 'manual-terminal', command: 'codex update', latestStatus };
    status = { state: 'error', version: '0.147.0' };
    const v = await render(createElement(NeedsCodex, { what: 'Continue.' }));
    t.after(() => v.unmount());
    assert.equal(v.host.querySelector('button'), null);
    await v.unmount();
  }
});

const show = async (state: string, what?: string) => {
  status = { state };
  calls.length = 0;
  return render(createElement(what ? NeedsCodex : CodexNotice, (what ? { what } : {}) as any));
};

test('a working Codex leaves only the note, without an action', async () => {
  for (const state of ['ready', 'apikey']) {
    const v = await show(state);
    assert.equal(v.host.querySelector('.login-hint')!.textContent, 'This page needs Codex. ');
    assert.equal(v.host.querySelector('button'), null);
    await v.unmount();
  }
});

test('while detecting it says so and offers nothing to click', async () => {
  const v = await show('detecting', 'Tasks need Codex.');
  assert.match(v.host.textContent!, /Tasks need Codex\. Connecting to Codex…/);
  assert.equal(v.host.querySelector('button'), null);
  await v.unmount();
});

test('signed out offers sign in, missing offers the installer, an error restarts and reconnects', async () => {
  let v = await show('signin');
  assert.match(v.host.textContent!, /Codex isn’t signed in\./);
  await click(byText(v.host, 'Sign in'));
  assert.deepEqual(calls.at(-1), ['signin', 'codex']);
  await v.unmount();

  v = await show('missing');
  await click(byText(v.host, 'Install Codex'));
  assert.deepEqual(calls.at(-1), ['open', 'https://install/codex']);
  await v.unmount();

  v = await show('error');
  assert.match(v.host.textContent!, /Couldn’t connect to Codex\./);
  await click(byText(v.host, 'Retry'));
  await flush();
  assert.deepEqual(calls.slice(-2), [['restart'], ['connect']]);
  await v.unmount();
});

test("a restart that fails says why instead of doing nothing, and doesn't reconnect", async () => {
  restartFails = true;
  try {
    const v = await show('error');
    await click(byText(v.host, 'Retry'));
    await flush();
    assert.deepEqual(calls.slice(-2), [['restart'], ['failed', "Couldn't restart Codex", 'no codex binary']]);
    await v.unmount();
  } finally {
    restartFails = false;
  }
});

test('the detecting fix is a no-op run with no label', async () => {
  status = { state: 'detecting' };
  let fix: any;
  const v = await render(createElement(() => ((fix = useCodexFix()), null)));
  assert.equal(fix.label, '');
  calls.length = 0;
  fix.run();
  assert.deepEqual(calls, []);
  await v.unmount();
});

test('while Codex updates it says so and offers no restart that would start the old binary (#3518)', async () => {
  version = { state: 'updating' };
  let v = await show('error', 'Codex plugins.');
  assert.match(v.host.textContent!, /Codex plugins\. Codex is updating\./);
  assert.equal(v.host.querySelector('button'), null);
  await v.unmount();
  // its action does nothing
  let fix: any = null;
  const Probe = () => ((fix = useCodexFix()), null);
  v = await render(createElement(Probe));
  assert.equal(fix.run(), undefined);
  await v.unmount();
  // an update waiting for chats hasn't started: the usual fix stays
  version = { state: 'waiting' };
  v = await show('error', 'Codex plugins.');
  assert.ok(byText(v.host, 'Retry'));
  await v.unmount();
  version = null;
});

test('a too-old Codex offers its update, not Retry; without an update it only says why (#3518)', async () => {
  version = { state: 'idle', updatable: true };
  status = { state: 'error', version: '0.147.0' };
  calls.length = 0;
  let v = await render(createElement(NeedsCodex, { what: 'Settings.' }));
  assert.match(v.host.textContent!, /Version 0\.147\.0 is too old for MoPilot\./);
  await click(byText(v.host, 'Update Codex'));
  assert.deepEqual(
    calls.filter((c) => c[0] === 'update'),
    [['update', 'codex', 'now']],
  );
  updateFails = true;
  await click(byText(v.host, 'Update Codex'));
  await flush();
  assert.deepEqual(calls.at(-1), ['failed', "Couldn't update Codex", 'IPC down']);
  updateFails = false;
  // main didn't start it: said, never a silent click
  updateResult = { ok: false, error: 'busy' };
  await click(byText(v.host, 'Update Codex'));
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', "Another update is running. Try again once it's done.", 'error']);
  updateResult = { ok: false, error: 'spawn', message: 'npm not found' };
  await click(byText(v.host, 'Update Codex'));
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't update Codex. Npm not found.", 'error']);
  updateResult = { ok: false, error: 'not-updatable' };
  await click(byText(v.host, 'Update Codex'));
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't update Codex. It can’t be updated from here.", 'error']);
  updateResult = { ok: true };
  await v.unmount();
  version = { state: 'idle', updatable: false };
  v = await render(createElement(NeedsCodex, { what: 'Settings.' }));
  assert.match(v.host.textContent!, /is too old/);
  assert.equal(v.host.querySelector('button'), null);
  await v.unmount();
  version = null;
});
