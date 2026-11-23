// The cloud accounts in Settings › MoMo › Sources (src/components/momo/ConnectorsSection.tsx, ConnectorCard.tsx, #2999 C0), the real components over a fake window.native.momoConnectors: nothing while no connector is registered; a card per account through its states (off, signing in with Cancel, connected, paused with Resume, sign in again), Pause and Disconnect behind Details with a confirm, a failure under the card but none for a cancelled sign-in, a list failure with Retry, no encryption, and reading again on every change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';

const React = await import('react');
const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');

const f: any = { calls: [], listeners: new Set() };
const ok = (x: object = {}) => ({ ok: true, ...x });
const rec =
  (name: string) =>
  async (...args: any[]) => (f.calls.push([name, ...args]), f.answers[name]?.(...args) ?? ok());
installNativeStub({
  momoConnectors: {
    list: rec('list'),
    connect: rec('connect'),
    cancel: rec('cancel'),
    disconnect: rec('disconnect'),
    setLevel: rec('setLevel'),
    onChanged: (cb: () => void) => (f.listeners.add(cb), () => f.listeners.delete(cb)),
  },
  // the slot's local sources and coding tools, with none listed
  momoSources: { list: async () => ok({ sources: [], available: true }), onChanged: () => () => {} },
  momoMcp: { list: async () => ok({ servers: [], available: true }), onChanged: () => () => {} },
});
const { MomoSourcesSlot } = await import('../src/components/momo/settings/SourcesSlot.tsx');
const { ConnectorsSection } = await import('../src/components/momo/ConnectorsSection.tsx');

const tools = [
  { name: 'list', kind: 'read', description: 'List the test notes.' },
  { name: 'add', kind: 'change', description: 'Add a test note.' },
];
const acct = (o: object = {}) => ({
  id: 'test-account',
  label: 'Test account',
  connected: false,
  account: null,
  scopes: [],
  level: 'ask',
  needsReconnect: false,
  connecting: false,
  tools,
  ...o,
});
const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
function reset(list: () => any) {
  f.calls = [];
  f.answers = { list };
}
async function mount(el: any = ConnectorsSection) {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(el)));
  await flush();
  const all = (sel: string, e: any = host) => [...e.querySelectorAll(sel)];
  const card = () => host.querySelector('section[aria-label="Test account"]') as any;
  const button = (label: string, e: any = host) => all('button', e).find((b: any) => b.textContent.trim() === label);
  const click = async (el: any) => {
    await act(async () => el.click());
    await flush();
  };
  return {
    host,
    card,
    button,
    click,
    status: () => card().querySelector('[data-status]').textContent.trim(),
    state: () => card().getAttribute('data-state'),
    chips: () => all('.hp-badge', card()).map((b: any) => b.textContent.trim()),
    alerts: () => all('[role="alert"]').map((a: any) => a.textContent),
    changed: async () => {
      await act(async () => f.listeners.forEach((cb: any) => cb()));
      await flush();
    },
    close: () => act(async () => root.unmount()),
  };
}

test('no connector registered: nothing shows (the Sources slot keeps only the local sources)', async () => {
  reset(async () => ok({ connectors: [], available: true }));
  const v = await mount();
  assert.equal(v.host.textContent, '');
  await v.close();
});

test('an account through its states: Connect, signing in with Cancel, connected, Pause and Resume, Disconnect with a confirm', async () => {
  let row: any = acct();
  reset(async () => ok({ connectors: [row], available: true }));
  const v = await mount();
  assert.equal(v.status(), 'Let MoMo use your Test account.');
  assert.equal(v.state(), 'off');
  assert.deepEqual(v.chips(), []);
  assert.match(v.card().querySelector('dl').textContent, /List the test notes\. Add a test note\./);
  // the sign-in waits for the browser: the row says so and offers Cancel
  let finish: (r: any) => void = () => {};
  f.answers.connect = () => new Promise((r) => (finish = r));
  await v.click(v.button('Connect'));
  row = acct({ connecting: true });
  await v.changed();
  assert.equal(v.status(), 'Finish signing in in your browser…');
  assert.equal(v.state(), 'connecting');
  await v.click(v.button('Cancel'));
  assert.deepEqual(f.calls.at(-2), ['cancel', 'test-account']);
  row = acct({ connected: true, account: 'me@test' });
  finish(ok({ connector: row }));
  await flush();
  assert.equal(v.status(), 'MoMo can use me@test.');
  assert.deepEqual(v.chips(), ['Connected']);
  assert.match(v.card().querySelector('dl').textContent, /Read; every change asks you first\./);
  // no account label: the provider's name
  row = acct({ connected: true });
  await v.changed();
  assert.equal(v.status(), 'MoMo can use your Test account.');
  await v.click(v.button('Pause'));
  assert.deepEqual(
    f.calls.find((c: any) => c[0] === 'setLevel'),
    ['setLevel', 'test-account', 'blocked'],
  );
  row = acct({ connected: true, level: 'blocked' });
  await v.changed();
  assert.equal(v.status(), "Paused. MoMo won't use it.");
  assert.deepEqual(v.chips(), ['Paused']);
  assert.equal(v.button('Pause'), undefined);
  await v.click(v.button('Resume'));
  assert.deepEqual(f.calls.filter((c: any) => c[0] === 'setLevel').at(-1), ['setLevel', 'test-account', 'ask']);
  // Disconnect asks first; Cancel keeps it
  await v.click(v.button('Disconnect'));
  assert.match(v.card().textContent, /Sign MoMo out of Test account\?/);
  await v.click(v.button('Cancel'));
  assert.equal(
    f.calls.some((c: any) => c[0] === 'disconnect'),
    false,
  );
  await v.click(v.button('Disconnect'));
  await v.click(v.button('Disconnect'));
  assert.deepEqual(
    f.calls.find((c: any) => c[0] === 'disconnect'),
    ['disconnect', 'test-account'],
  );
  await v.close();
});

test('read only and lost accounts: the details say the access; a lost one offers Sign in again', async () => {
  let row: any = acct({ connected: true, level: 'read' });
  reset(async () => ok({ connectors: [row], available: true }));
  const v = await mount();
  assert.match(v.card().querySelector('dl').textContent, /Read only\./);
  row = acct({ needsReconnect: true });
  await v.changed();
  assert.equal(v.status(), 'Test account signed MoMo out. Sign in again to keep using it.');
  assert.deepEqual(v.chips(), ['Sign in again']);
  assert.equal(v.state(), 'reconnect');
  await v.click(v.button('Sign in again'));
  assert.deepEqual(
    f.calls.find((c: any) => c[0] === 'connect'),
    ['connect', 'test-account'],
  );
  await v.close();
});

test('failures: one under the card until the next call, none for a cancelled or stale sign-in, a thrown one too', async () => {
  reset(async () => ok({ connectors: [acct()], available: true }));
  const v = await mount();
  f.answers.connect = async () => ({ ok: false, error: 'The sign-in was not allowed (access_denied)', reason: 'denied' });
  await v.click(v.button('Connect'));
  assert.deepEqual(v.alerts(), ['The sign-in was not allowed (access_denied)']);
  f.answers.connect = async () => ({ ok: false, error: 'The sign-in was cancelled', reason: 'closed' });
  await v.click(v.button('Connect'));
  assert.deepEqual(v.alerts(), []);
  f.answers.connect = async () => ({ ok: false, error: 'Another sign-in came first', reason: 'stale' });
  await v.click(v.button('Connect'));
  assert.deepEqual(v.alerts(), []);
  f.answers.connect = async () => {
    throw new Error('bridge gone');
  };
  await v.click(v.button('Connect'));
  assert.equal(v.alerts().length, 1);
  assert.match(v.alerts()[0], /bridge gone/);
  await v.close();
});

test('the list: a failure with Retry, a throw, no encryption, and only the newest answer shown', async () => {
  reset(async () => ({ ok: false, error: 'MoMo is not available', reason: 'not_allowed' }));
  const v = await mount();
  assert.match(v.alerts()[0], /Couldn't load accounts: MoMo is not available/);
  f.answers.list = async () => ok({ connectors: [acct()], available: true });
  await v.click(v.button('Retry'));
  assert.deepEqual(v.alerts(), []);
  assert.ok(v.card());
  f.answers.list = async () => {
    throw new Error('ipc down');
  };
  await v.changed();
  assert.match(v.alerts()[0], /ipc down/);
  f.answers.list = async () => ok({ connectors: [], available: false });
  await v.changed();
  assert.match(v.host.textContent, /need encryption, which isn't available/);
  // two loads at once: the older answer, and the older failure, arrive last and are dropped
  const gates: ((v: any) => void)[] = [];
  f.answers.list = () => new Promise((r) => gates.push(r));
  await v.changed();
  await v.changed();
  gates[1](ok({ connectors: [acct({ label: 'Test account' })], available: true }));
  await flush();
  gates[0](ok({ connectors: [], available: false }));
  await flush();
  assert.ok(v.card());
  const throws: ((e: any) => void)[] = [];
  f.answers.list = () => new Promise((_r, j) => throws.push(j));
  await v.changed();
  f.answers.list = async () => ok({ connectors: [acct()], available: true });
  await v.changed();
  throws[0](new Error('late'));
  await flush();
  assert.deepEqual(v.alerts(), []);
  await v.close();
});

test('the Sources slot mounts the accounts after the local sources', async () => {
  reset(async () => ok({ connectors: [acct()], available: true }));
  const v = await mount(MomoSourcesSlot);
  assert.ok(v.card());
  await v.close();
});
