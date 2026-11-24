// Remote Git recovery through the real renderer sign-in store: device flow, reload hydration, failure states, explicit retry and provider/machine isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { render, click, flush, byText, maybeText } from './support/shell-chrome-kit.ts';
import { mockSource } from './support/stubs.ts';
import { useFakeNative } from './support/ports/native.ts';
import type { GitSignIn } from '../src/lib/hostGitSignIn.ts';
import { createRequire } from 'node:module';
const { LOCAL_ID } = createRequire(import.meta.url)('../electron/host/localHost.cjs');

mockSource('src/lib/host.ts', { useHostAccess: () => true });
const terminals: string[] = [];
mockSource('src/components/pages/settings/Connections.tsx', { openSshTerminal: (target: string) => terminals.push(target) });
const { RemoteGitSignin: Recovery } = await import('../src/components/composer/RemoteGitSignin.tsx');
const RemoteGitSignin = (props: Omit<import('react').ComponentProps<typeof Recovery>, 'recoveryKey'>) =>
  h(Recovery, { ...props, recoveryKey: 'failure-1' });
const { useGitSignIn } = await import('../src/lib/hostGitSignIn.ts');
const machine = { id: 'ssh:box', name: 'Build box', away: false };
const view = (o = {}) => ({
  hostId: machine.id,
  harness: 'git:github.com',
  state: 'waiting',
  codes: [],
  link: false,
  url: null,
  error: null,
  reason: null,
  attemptId: 'attempt-1',
  recoveryKeys: ['failure-1'],
  ...o,
});

test('a Git capability refusal offers My machines and waits for an explicit sign-in after updating', async (t) => {
  let openedMachines = 0;
  const api = useFakeNative(t, {
    host: {
      signinViews: async () => [view({ state: 'failed', reason: 'host_update', error: 'The Host lacks gitSignin. Update it.' })],
      signin: async () => view({ state: 'starting' }),
    },
  });
  const ui = await render(h(RemoteGitSignin, { machine, host: 'github.com', onOpenMachines: () => openedMachines++ }));
  t.after(() => ui.unmount());
  assert.match(ui.host.textContent!, /The last sign-in attempt required a Host update.*Check Build box/);
  assert.doesNotMatch(ui.host.textContent!, /lacks gitSignin|Sign in again/);
  await click(byText(ui.host, 'My machines'));
  assert.equal(openedMachines, 1);
  assert.deepEqual(api.callsTo('host.update'), []);
  assert.deepEqual(api.callsTo('host.signin'), []);
  await click(byText(ui.host, 'Try sign-in after updating'));
  assert.deepEqual(api.callsTo('host.signin'), [[machine.id, 'git:github.com', 'failure-1']]);
  assert.equal(maybeText(ui.host, 'My machines'), null);
  assert.ok(maybeText(ui.host, 'Cancel'));
});

test('a relay Host gets update guidance and a new unreachable result supersedes an old refusal', async (t) => {
  const relay = { ...machine, id: 'relay:box' };
  const api = useFakeNative(t, {
    host: {
      signinViews: async () => [view({ hostId: relay.id, state: 'failed', reason: 'host_update' })],
      signin: async () => {
        throw new Error('The connection closed.');
      },
    },
  });
  const ui = await render(h(RemoteGitSignin, { machine: relay, host: 'github.com' }));
  t.after(() => ui.unmount());
  assert.match(ui.host.textContent!, /Control other devices for update options/);
  assert.deepEqual(api.callsTo('host.update'), []);
  await click(byText(ui.host, 'Try sign-in after updating'));
  assert.match(ui.host.textContent!, /Couldn’t contact the machine/);
});

test('a refusal on a retired operation cannot offer to update another machine or replace the current sign-in', async (t) => {
  const api = useFakeNative(t, {
    host: {
      signinViews: async () => [],
    },
  });
  const ui = await render(h(RemoteGitSignin, { machine, host: 'github.com', onOpenMachines: () => assert.fail('unrelated refusal') }));
  t.after(() => ui.unmount());
  const refusal = { state: 'failed', reason: 'host_update' };
  await act(() => api.emit('host.onSignin', view({ ...refusal, recoveryKeys: ['old-operation'] })));
  assert.equal(maybeText(ui.host, 'My machines'), null);
  await act(() => api.emit('host.onSignin', view({ ...refusal, hostId: 'ssh:other' })));
  assert.equal(maybeText(ui.host, 'My machines'), null);
  await act(() => api.emit('host.onSignin', view({ state: 'waiting', reason: 'host_update' })));
  assert.equal(maybeText(ui.host, 'My machines'), null);
  assert.ok(maybeText(ui.host, 'Cancel'));
});

test('sign-in is explicit and shows only the browser code until GitHub is ready', async (t) => {
  const api = useFakeNative(t, {
    host: {
      signinViews: async () => [],
      signin: async () => view({ state: 'starting' }),
      cancelSignin: async () => {
        api.emit('host.onSignin', view({ state: 'cancelled' }));
        return true;
      },
    },
  });
  const ui = await render(h(RemoteGitSignin, { machine, host: 'github.com' }));
  t.after(() => ui.unmount());
  assert.match(ui.host.textContent!, /github.com on Build box/);
  assert.equal(ui.host.querySelector('.host-signin-line'), null);
  assert.equal(api.callsTo('host.signin').length, 0);
  await click(byText(ui.host, 'Sign in to GitHub'));
  assert.deepEqual(api.callsTo('host.signin'), [[machine.id, 'git:github.com', 'failure-1']]);
  await act(() => api.emit('host.onSignin', view({ codes: ['ABCD-1234'], url: 'https://github.com/login/device', link: true })));
  assert.match(ui.host.textContent!, /Enter this code on GitHub.*ABCD-1234/);
  assert.equal(ui.host.querySelector('input'), null);
  await click(byText(ui.host, 'Copy code'));
  assert.deepEqual(api.callsTo('clipboard.write'), [['ABCD-1234']]);
  assert.equal(api.callsTo('host.signinInput').length, 0);
  await click(byText(ui.host, 'Open GitHub'));
  assert.deepEqual(api.callsTo('shell.openExternal'), [['https://github.com/login/device']]);
  await click(byText(ui.host, 'Cancel'));
  assert.match(ui.host.textContent!, /Sign-in cancelled/);
  await click(byText(ui.host, 'Sign in again'));
  await act(() => api.emit('host.onSignin', view({ state: 'signed-in' })));
  assert.match(ui.host.textContent!, /Git is signed in to github.com on Build box/);
  assert.equal(ui.host.querySelector('button'), null);
  assert.equal(ui.host.querySelector('.host-signin-line'), null);
});

test('failures, expiry, disconnect, offline and rejected actions remain visible and retryable', async (t) => {
  const api = useFakeNative(t, {
    host: {
      signinViews: async () => [],
      signin: async () => {
        throw new Error('gone');
      },
    },
    shell: {
      openExternal: async () => {
        throw new Error('no browser');
      },
    },
  });
  const props = { machine, host: 'github.com' };
  const ui = await render(h(RemoteGitSignin, props));
  await click(byText(ui.host, 'Sign in to GitHub'));
  assert.match(ui.host.textContent!, /Couldn’t contact the machine/);
  await ui.unmount();
  const next = await render(h(RemoteGitSignin, props));
  t.after(() => next.unmount());
  for (const [state, text] of [
    ['failed', "Couldn't sign in to GitHub"],
    ['expired', 'That code expired'],
    ['unreachable', "Couldn't reach the machine"],
  ]) {
    await act(() => api.emit('host.onSignin', view({ state, error: 'Update Host on that machine.' })));
    assert.match(next.host.textContent!, new RegExp(text));
    assert.match(next.host.querySelector('details')?.textContent ?? '', state === 'expired' ? /^$/ : /Update Host/);
  }
  await act(() => api.emit('host.onSignin', view({ url: 'https://github.com/login/device', link: true })));
  await click(byText(next.host, 'Open GitHub'));
  assert.match(next.host.textContent!, /Couldn’t open the sign-in page/);
  await next.rerender(h(RemoteGitSignin, { ...props, machine: { ...machine, away: true } }));
  assert.equal((byText(next.host, 'Cancel') as HTMLButtonElement).disabled, false, 'cancellation remains available offline');
  await next.rerender(h(RemoteGitSignin, props));
  await act(() => api.emit('host.onSignin', view({ state: 'signed-in' })));
  assert.equal(next.host.querySelector('.host-signin-line'), null, 'verified success clears the browser reminder');
});

test('a non-device URL is never offered as a GitHub sign-in page', async (t) => {
  const api = useFakeNative(t, {
    host: { signinViews: async () => [view({ url: 'https://github.com/login/device?other=1', link: true, codes: ['ABCD-1234'] })] },
  });
  const ui = await render(h(RemoteGitSignin, { machine, host: 'github.com' }));
  t.after(() => ui.unmount());
  assert.deepEqual(
    [...ui.host.querySelectorAll('button')].map((button) => button.textContent),
    ['Copy code', 'Cancel'],
  );
  assert.deepEqual(api.callsTo('shell.openExternal'), []);
});

test('a late start acknowledgement cannot overwrite a newer live success or a cancelled subscription', async (t) => {
  let answer!: (value: any) => void;
  const api = useFakeNative(t, {
    host: {
      signinViews: async () => [],
      signin: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    },
  });
  const ui = await render(h(RemoteGitSignin, { machine, host: 'github.com' }));
  await click(byText(ui.host, 'Sign in to GitHub'));
  await act(() => api.emit('host.onSignin', view({ state: 'signed-in' })));
  await act(() => answer(view({ state: 'starting' })));
  assert.match(ui.host.textContent!, /Git is signed in/);
  await ui.unmount();
  const next = await render(h(RemoteGitSignin, { machine, host: 'github.com' }));
  await click(byText(next.host, 'Sign in to GitHub'));
  await next.unmount();
  await act(() => answer(view({ state: 'waiting' })));
});

test('reload reads existing attempts, retains newer live state over an older snapshot and ignores retired snapshot reads', async (t) => {
  let resolve!: (v: any) => void;
  const api = useFakeNative(t, {
    host: {
      signinViews: () =>
        new Promise((r) => {
          resolve = r;
        }),
    },
  });
  const ui = await render(h(RemoteGitSignin, { machine, host: 'github.com' }));
  await act(() => api.emit('host.onSignin', view({ state: 'expired' })));
  await act(async () => {
    resolve([view(), null]);
  });
  assert.match(ui.host.textContent!, /That code expired/);
  await ui.unmount();
  const reloaded = await render(h(RemoteGitSignin, { machine, host: 'github.com' }));
  await act(async () => {
    resolve([view({ codes: ['EFGH-5678'] }), { nope: true }]);
  });
  assert.match(reloaded.host.textContent!, /EFGH-5678/);
  await reloaded.unmount();
  const gone = await render(h(RemoteGitSignin, { machine, host: 'github.com' }));
  await gone.unmount();
  await act(async () => {
    resolve([view({ state: 'signed-in' })]);
  });
  await flush();
});

test('old successes and other machines never resolve a new failure; unsupported providers open only the remote terminal', async (t) => {
  const api = useFakeNative(t, { host: { signinViews: async () => [view({ state: 'signed-in', recoveryKeys: ['prior-failure'] })] } });
  const ui = await render(h(RemoteGitSignin, { machine, host: 'github.com' }));
  t.after(() => ui.unmount());
  assert.match(ui.host.textContent!, /Git isn’t signed in/);
  await act(() => api.emit('host.onSignin', view({ hostId: 'ssh:other', state: 'signed-in' })));
  assert.match(ui.host.textContent!, /Git isn’t signed in/);
  await ui.rerender(h(RemoteGitSignin, { key: 'other', machine, host: 'git.example.test' }));
  await click(byText(ui.host, 'Open remote terminal'));
  assert.deepEqual(terminals, ['box']);
  assert.equal(api.callsTo('host.signin').length, 0);
  await ui.rerender(h(RemoteGitSignin, { key: 'local', machine: { ...machine, id: 'local' }, host: 'github.com' }));
  assert.equal(ui.host.querySelector('button'), null);
  await ui.rerender(h(RemoteGitSignin, { key: 'real-local', machine: { ...machine, id: LOCAL_ID }, host: 'github.com' }));
  assert.equal(ui.host.querySelector('[data-git-signin-note]'), null);
  await ui.rerender(h(RemoteGitSignin, { key: 'offline', machine: { ...machine, away: true }, host: 'github.com' }));
  assert.match(ui.host.textContent!, /Build box is offline/);
  assert.equal((byText(ui.host, 'Sign in to GitHub') as HTMLButtonElement).disabled, true);
});

test('a verified Git login refreshes the machine row and retires an older negative read on every surface', async (t) => {
  const reads: ((value: any) => void)[] = [];
  const api = useFakeNative(t, {
    host: {
      signinViews: async () => [],
      gitSignIn: () => new Promise((r) => reads.push(r)),
    },
  });
  let row: ReadonlyMap<string, GitSignIn> = new Map();
  const Surface = () => {
    row = useGitSignIn([{ ...machine, status: 'online' } as any]);
    return h(RemoteGitSignin, { machine, host: 'github.com' });
  };
  const ui = await render(h(Surface));
  t.after(() => ui.unmount());
  assert.equal(reads.length, 1);
  await act(() => api.emit('host.onSignin', view({ state: 'signed-in' })));
  assert.equal(reads.length, 2);
  await act(async () => {
    reads[1]({ 'github.com': 'yes' });
  });
  await act(async () => {
    reads[0]({ 'github.com': 'no' });
  });
  assert.equal(row.get(machine.id), 'yes');
  assert.match(ui.host.textContent!, /Git is signed in/);
  await act(() => api.emit('host.onSignin', view({ hostId: 'ssh:other', attemptId: 'other', state: 'signed-in' })));
  assert.equal(reads.length, 2, 'a completion on another machine preserves this machine’s read');
  await act(() => api.emit('host.onSignin', view({ attemptId: 'attempt-2', state: 'signed-in' })));
  assert.equal(reads.length, 3, 'a second sign-in on this machine invalidates its previous credential read');
  await act(async () => {
    reads[2]({ 'github.com': 'yes' });
  });
});
