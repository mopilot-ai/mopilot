// Usage Settings journey through the real phone sheet, including offline/old Mac recovery and account grouping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
const settingsPath = '../mobile/src/screens/Settings';
const { Settings } = await import(settingsPath);
const at = Date.now();
const snap: any = {
  phase: 'online',
  selectedPair: 'p',
  generation: 1,
  pairs: [{ pairId: 'p', name: 'Studio Mac' }],
  presence: {},
  user: null,
};
let root: any, host: HTMLElement;
test.afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
});
async function mount(handler: (m: string, p?: any) => any, state = snap) {
  const s = scripted(handler, state);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const props = {
    runtime: s.runtime,
    state,
    busy: false,
    error: null,
    pushUi: { step: 'prompt' },
    home: () => {},
    pair: () => {},
    connect: () => {},
    remove: () => {},
    signOut: () => {},
    deleteAccount: async () => {},
  };
  await act(async () => root.render(createElement(Settings, props)));
  await flush();
  await click('Usage');
  return { s, props };
}
test('Settings → Usage shows per-account percentages and reset times, unsupported/signin states, then refresh and Back', async () => {
  const { s } = await mount((m) =>
    m === 'machine.hello'
      ? { capabilities: { methods: ['usage.get'] } }
      : m === 'usage.get'
        ? {
            scope: 'local',
            accounts: [
              {
                harness: 'claude',
                account: 'work',
                label: 'Work',
                active: true,
                state: 'available',
                windows: [{ label: '5h', usedPercent: 62, resetsAt: at / 1000 + 3600, at, stale: false }],
              },
              {
                harness: 'codex',
                account: 'personal',
                label: 'Personal',
                state: 'available',
                windows: [{ label: 'Weekly', usedPercent: 100, resetsAt: at / 1000 - 5, at, stale: true }],
              },
              { harness: 'acp', account: 'agent', label: 'Agent', state: 'unsupported', windows: [] },
              { harness: 'claude', account: 'old', label: 'Old', state: 'signin', windows: [] },
            ],
          }
        : undefined,
  );
  assert.match(host.textContent!, /Studio Mac · This Mac only/);
  assert.match(host.textContent!, /Claude Code.*Work.*Active/);
  assert.match(host.textContent!, /38% left.*Resets in (59|60) min|38% left.*Resets in 1 h/);
  assert.match(host.textContent!, /Codex.*Personal.*Refresh needed.*Reset since last read/);
  assert.match(host.textContent!, /No usage for this account/);
  assert.match(host.textContent!, /Sign in on your Mac/);
  await click('Refresh');
  assert.equal(s.calls.filter(([m]) => m === 'usage.get').length, 2);
  await click('Back');
  assert.match(host.textContent!, /Settings/);
});
test('old Mac explains update; a transport failure can retry; offline asks for wake without a request', async () => {
  let fail = true;
  await mount((m) =>
    m === 'machine.hello'
      ? { capabilities: { methods: ['usage.get'] } }
      : m === 'usage.get'
        ? fail
          ? Promise.reject(new Error('Computer is offline'))
          : { scope: 'local', accounts: [] }
        : undefined,
  );
  assert.match(host.textContent!, /offline or asleep/);
  fail = false;
  await click('Refresh');
  assert.match(host.textContent!, /No accounts on this Mac/);
  await act(async () => root.unmount());
  host.remove();
  await mount(() => undefined);
  assert.match(host.textContent!, /Update MoPilot/);
  await act(async () => root.unmount());
  host.remove();
  const { s } = await mount(() => undefined, { ...snap, phase: 'offline' });
  assert.match(host.textContent!, /offline or asleep/);
  assert.equal(s.calls.length, 0);
});

test('a mounted page invalidates percentages after reset and connection changes discard pending old Mac results', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: at });
  const wire = {
    scope: 'local',
    accounts: [
      {
        harness: 'codex',
        account: 'a',
        label: 'A',
        state: 'available',
        windows: [{ label: '5h', usedPercent: 10, resetsAt: at / 1000 + 1, at, stale: false }],
      },
    ],
  };
  const { props, s } = await mount((m) =>
    m === 'machine.hello' ? { capabilities: { methods: ['usage.get'] } } : m === 'usage.get' ? wire : undefined,
  );
  assert.match(host.textContent!, /90% left/);
  await act(async () => t.mock.timers.tick(30000));
  assert.match(host.textContent!, /Reset since last read/);
  await act(async () => root.render(createElement(Settings, { ...props, state: { ...snap, phase: 'offline' } })));
  assert.doesNotMatch(host.textContent!, /90% left/);
  assert.match(host.textContent!, /offline or asleep/);
  s.state.snap = { ...snap, generation: 2 };
  await act(async () => root.render(createElement(Settings, { ...props, state: s.state.snap })));
  await flush();
  assert.match(host.textContent!, /Reset since last read/);
});

test('the mounted Usage screen renews its canonical request after reconnect and drops an earlier connection’s late answer', async () => {
  const usageScreenPath = '../mobile/src/screens/SettingsUsage';
  const { SettingsUsage } = await import(usageScreenPath);
  const wire = (usedPercent: number) => ({
    scope: 'local',
    accounts: [
      {
        harness: 'codex',
        account: 'a',
        label: 'A',
        state: 'available',
        windows: [{ label: '5h', usedPercent, resetsAt: at / 1000 + 3600, at, stale: false }],
      },
    ],
  });
  let finishOld!: (answer: unknown) => void;
  let reads = 0;
  const s = scripted(
    (method) =>
      method === 'machine.hello'
        ? { capabilities: { methods: ['usage.get'] } }
        : method === 'usage.get'
          ? ++reads === 1
            ? new Promise((resolve) => {
                finishOld = resolve;
              })
            : wire(20)
          : undefined,
    snap,
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const render = async () => {
    await act(async () => root.render(createElement(SettingsUsage, { runtime: s.runtime, state: s.runtime.snapshot(), back: () => {} })));
    await flush();
  };
  await render();
  assert.match(host.textContent!, /Refreshing…/);
  s.state.snap = { ...snap, generation: 2 };
  await render();
  assert.match(host.textContent!, /80% left/);
  assert.equal(reads, 2);
  await act(async () => finishOld(wire(99)));
  await flush();
  assert.match(host.textContent!, /80% left/);
  assert.doesNotMatch(host.textContent!, /1% left/);
  s.state.snap = { ...snap, generation: 2, phase: 'offline' };
  await render();
  assert.match(host.textContent!, /offline or asleep/);
  assert.doesNotMatch(host.textContent!, /80% left/);
  s.state.snap = { ...snap, generation: 3 };
  await render();
  assert.match(host.textContent!, /80% left/);
  assert.equal(reads, 3);
});

test('an unfamiliar harness keeps its own identity and unavailable usage state instead of borrowing another agent label', async () => {
  await mount((method) =>
    method === 'machine.hello'
      ? { capabilities: { methods: ['usage.get'] } }
      : method === 'usage.get'
        ? {
            scope: 'local',
            accounts: [{ harness: 'acp:future-agent', account: 'research', label: 'Research', state: 'unsupported', windows: [] }],
          }
        : undefined,
  );
  assert.match(host.textContent!, /Future agent.*Research.*No usage for this account/);
  assert.doesNotMatch(host.textContent!, /Claude Code|Codex|% left/);
});

const win = (label: string, usedPercent: number, extra: any = {}) => ({
  label,
  usedPercent,
  resetsAt: at / 1000 + 7800,
  at,
  stale: false,
  ...extra,
});
const login = (harness: string, account: string, label: string, extra: any = {}) => ({
  harness,
  account,
  label,
  status: 'ok',
  billing: 'subscription',
  active: false,
  limited: false,
  ...extra,
});
const accountList = (harnesses: any[], accounts: any[]) => ({ scope: 'local', harnesses, accounts });
const usageOf = (accounts: any[]) => ({ scope: 'local', accounts });
const available = (harness: string, account: string, label: string, windows: any[], extra: any = {}) => ({
  harness,
  account,
  label,
  active: false,
  state: 'available',
  windows,
  ...extra,
});

test('the Mac’s account list is the base: a signed-out and an expired login are listed, a limited one says so, names come from the Mac', async () => {
  await mount((m) =>
    m === 'machine.hello'
      ? { capabilities: { methods: ['usage.get', 'accounts.get', 'accounts.autoSwitch', 'harnesses.list'] } }
      : m === 'usage.get'
        ? usageOf([available('codex', 'a', 'a@x.com', [win('5h', 100), win('Weekly', 40)], { active: true })])
        : m === 'accounts.get'
          ? accountList(
              [{ harness: 'codex', autoSwitch: true, pool: 'spread' }],
              [
                login('codex', 'a', 'a@x.com', { active: true, limited: true }),
                login('codex', 'b', 'b@x.com', { status: 'signedOut' }),
                login('codex', 'c', 'c@x.com', { status: 'expired' }),
              ],
            )
          : m === 'harnesses.list'
            ? { harnesses: [], states: [{ id: 'codex', label: 'Codex CLI', kind: 'builtin', state: 'ready', canSwitch: true }] }
            : undefined,
  );
  const text = host.textContent!;
  assert.match(text, /Codex CLI/);
  assert.match(text, /a@x\.com.*Limited.*5h.*0% left.*Resets in 2 h 10 min.*Weekly.*60% left/);
  assert.match(text, /b@x\.com.*Signed out.*Sign in on your Mac/);
  assert.match(text, /c@x\.com.*Expired.*Sign in on your Mac/);
  assert.equal(host.querySelectorAll('[role="switch"]').length, 1);
});

test('Codex with no login lists nothing, with one lists it, with two lists both; a login never read says so', async () => {
  for (const [logins, expect] of [
    [[], /No accounts on this Mac/],
    [[login('codex', 'a', 'a@x.com')], /a@x\.com.*Not fetched yet/],
    [[login('codex', 'a', 'a@x.com'), login('codex', 'b', 'b@x.com')], /a@x\.com.*Not fetched yet.*b@x\.com.*Not fetched yet/],
  ] as [any[], RegExp][]) {
    await mount((m) =>
      m === 'machine.hello'
        ? { capabilities: { methods: ['usage.get', 'accounts.get'] } }
        : m === 'usage.get'
          ? usageOf([])
          : m === 'accounts.get'
            ? accountList([{ harness: 'codex', autoSwitch: false, pool: 'single' }], logins)
            : undefined,
    );
    assert.match(host.textContent!, expect);
    await act(async () => root.unmount());
    host.remove();
  }
});

test('switch-at-a-limit changes the Mac’s setting for that agent; a refusal puts the old value back and says so; one change at a time', async () => {
  let refuse = false;
  const { s } = await mount((m, p) =>
    m === 'machine.hello'
      ? { capabilities: { methods: ['usage.get', 'accounts.get', 'accounts.autoSwitch'] } }
      : m === 'usage.get'
        ? usageOf([])
        : m === 'accounts.get'
          ? accountList([{ harness: 'claude', autoSwitch: true, pool: 'single' }], [login('claude', 'w', 'Work', { active: true })])
          : m === 'accounts.autoSwitch'
            ? refuse
              ? Promise.reject(new Error('The Mac said no'))
              : { harness: p.harness, autoSwitch: p.on }
            : undefined,
  );
  const toggle = () => document.querySelector('[aria-label^="Switch at a limit"]') as HTMLElement;
  const on = () => toggle().getAttribute('aria-checked') === 'true';
  assert.equal(on(), true);
  await act(async () => toggle().click());
  await flush();
  assert.deepEqual(s.calls.filter(([m]) => m === 'accounts.autoSwitch').at(-1), ['accounts.autoSwitch', { harness: 'claude', on: false }]);
  assert.equal(on(), false);
  refuse = true;
  await act(async () => toggle().click());
  await flush();
  assert.equal(on(), false, 'the refused change leaves the setting where it was');
  assert.match(host.textContent!, /The Mac said no/);
});

test('an old reading is marked, a nearly used one is red; a Mac that lists agents and one that sends none both work; one agent’s switch leaves the other’s', async () => {
  let labels: () => any = () => ({
    harnesses: [],
    states: [{ id: 'claude', label: 'Claude Code', kind: 'builtin', state: 'ready', canSwitch: true }],
  });
  const { s } = await mount((m, p) =>
    m === 'machine.hello'
      ? { capabilities: { methods: ['usage.get', 'accounts.get', 'accounts.autoSwitch', 'harnesses.list'] } }
      : m === 'usage.get'
        ? usageOf([
            available('claude', 'w', 'Work', [win('5h', 96, { stale: true })], { active: true }),
            available('codex', 'a', 'a@x.com', [win('Weekly', 10)], { active: true }),
          ])
        : m === 'accounts.get'
          ? accountList(
              [
                { harness: 'claude', autoSwitch: true, pool: 'single' },
                { harness: 'codex', autoSwitch: true, pool: 'spread' },
              ],
              [login('claude', 'w', 'Work', { active: true }), login('codex', 'a', 'a@x.com', { active: true })],
            )
          : m === 'harnesses.list'
            ? labels()
            : m === 'accounts.autoSwitch'
              ? { harness: p.harness, autoSwitch: p.on }
              : undefined,
  );
  assert.match(host.textContent!, /4% left · Last known/);
  const switches = () => [...document.querySelectorAll('[aria-label^="Switch at a limit"]')] as HTMLElement[];
  assert.equal(switches().length, 2);
  await act(async () => switches()[0].click());
  await flush();
  assert.deepEqual(
    switches().map((el) => el.getAttribute('aria-checked')),
    ['false', 'true'],
  );
  assert.equal(s.calls.filter(([m]) => m === 'accounts.autoSwitch').length, 1);
  // an older Mac that has the method but sends no agent rows, and one whose list fails, still show the page
  for (const reply of [() => ({ harnesses: [] }), () => Promise.reject(new Error('no'))]) {
    labels = reply;
    await click('Refresh');
    assert.match(host.textContent!, /Work/);
  }
});
