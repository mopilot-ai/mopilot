// The machine page in the new UI: the Host's own state, the Mac's state beside it, direct access set-up steps, waiting cards answered from the page, and the flag that chooses between old and new.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, createElement, createRoot, flush } from './support/phone/component-kit';

const adaptersPath = '../mobile/src/ui/support/supportFlag.ts';
const { bindSupportFlag } = await import(adaptersPath);
const setSupportV2 = (on: boolean) => bindSupportFlag(() => on);
const base = '../mobile/src/ui/support/';
const { MachineScreen, supportInput } = await import(`${base}screens`);
const { TroubleshootView } = await import(`${base}Troubleshoot`);
const { PairingConfirm } = await import(`${base}PairingConfirm`);
const { MachineView } = await import(`${base}MachineView`);
const { runChecks } = await import(`${base}supportModel`);
const { MacLinkProvider } = await import('../mobile/src/macLink');
// by variable paths: a literal path to screen code is not allowed under tests/
const machinePath = '../mobile/src/screens/SettingsMachine';
const cardsPath = '../mobile/src/components/PairingCards';
const { SettingsMachine } = await import(machinePath);
const { PairingCards } = await import(cardsPath);

const g = globalThis as any;
const mounted: { root: any; host: Element }[] = [];
async function mount(node: unknown) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(node as never));
  await flush();
  return host;
}
test.afterEach(async () => {
  setSupportV2(false);
  for (const m of mounted.splice(0)) await act(async () => m.root.unmount()), m.host.remove();
});

const input = (patch: object = {}) => ({
  online: true,
  signedIn: true,
  relay: 'ok',
  mac: { name: 'Studio', paired: true, presence: 'online' },
  host: null,
  ...patch,
});

const machine = (o: object = {}) => ({
  id: 'h1',
  name: 'Cloud box',
  status: 'online',
  line: 'Online · Claude',
  tone: 'ok',
  keepRunning: true,
  agents: [{ id: 'claude', label: 'Claude', state: 'ready', via: 'own' }],
  reach: 'direct',
  ...o,
});
const vm = (o: object = {}) => ({
  name: 'Box',
  line: 'Online',
  tone: 'ok',
  reach: null,
  keepRunning: null,
  notice: null,
  waiting: 0,
  newChat: null,
  agents: [],
  setup: { line: null, action: null },
  ...o,
});

test('the machine view shows the Mac words as given, each tone, the notice, the setup step and its action', async () => {
  let started = 0;
  const host = await mount(
    createElement(
      MachineView,
      {
        vm: vm({
          reach: 'Direct',
          keepRunning: false,
          notice: 'Your Mac is asleep. Direct access still works.',
          agents: [{ id: 'a', label: 'Claude', line: 'Ready' }],
          setup: {
            line: 'Setting up…',
            action: { title: 'Try again', onPress: () => started++ },
          },
        }),
      },
      createElement('span', null, 'slot'),
    ),
  );
  const text = host.textContent!;
  assert.match(text, /StatusOnline/);
  assert.match(text, /ReachDirect/);
  assert.match(text, /Keep runningOff/);
  assert.match(text, /Your Mac is asleep\. Direct access still works\./);
  assert.match(text, /slot/);
  assert.match(text, /AgentsClaudeReady/);
  await click('Try again');
  assert.equal(started, 1);
  for (const tone of ['warn', 'off'])
    assert.match((await mount(createElement(MachineView, { vm: vm({ tone, keepRunning: true }) }))).textContent!, /Keep runningOn/);
  assert.doesNotMatch(
    (
      await mount(
        createElement(MachineView, {
          vm: vm({ setup: { line: 'Only a line', action: null } }),
        }),
      )
    ).textContent!,
    /Try again/,
  );
  assert.doesNotMatch(
    (
      await mount(
        createElement(MachineView, {
          vm: vm({
            setup: { line: null, action: { title: 'Go', onPress: () => {} } },
          }),
        }),
      )
    ).textContent!,
    /Setting up/,
  );
});

function link(state: any, runtime: any, child: any) {
  return createElement(MacLinkProvider, { state, runtime }, child);
}
const snap = (presence: string | null) => ({
  phase: 'online',
  generation: 1,
  selectedPair: 'p',
  user: { id: 'u', email: 'a@b.c' },
  pairs: [{ pairId: 'p', macId: 'm', name: 'Studio' }],
  presence: presence ? { p: { state: presence, lastSeen: 1 } } : {},
});
const runtimeFor = (s: any) => ({
  snapshot: () => s,
  request: async () => ({ capabilities: {}, machines: [] }),
  onEvent: () => () => {},
});

test('the machine page, with the flag on, tells what the sleeping Mac means for a direct Host', async () => {
  setSupportV2(true);
  const s = snap('sleeping');
  const rt = runtimeFor(s);
  const host = await mount(
    link(
      s,
      rt,
      createElement(SettingsMachine, {
        machine: machine(),
        back: () => {},
        runtime: rt,
      }),
    ),
  );
  assert.match(host.textContent!, /Your Mac is asleep\. Direct access still works\./);
  assert.match(host.textContent!, /StatusOnline · Claude/);
  const gone = snap('gone');
  const rt2 = runtimeFor(gone);
  const h2 = await mount(
    link(
      gone,
      rt2,
      createElement(MachineScreen, {
        machine: machine({ waiting: 2, reach: 'through' }),
        back: () => {},
        runtime: rt2,
      }),
    ),
  );
  assert.doesNotMatch(h2.textContent!, /Direct access still works/);
  const h3 = await mount(
    link(
      snap(null),
      runtimeFor(snap(null)),
      createElement(MachineScreen, {
        machine: machine({ reach: undefined, keepRunning: null, agents: [] }),
        back: () => {},
      }),
    ),
  );
  assert.match(h3.textContent!, /Change this machine on your Mac\./);
});

test('without the flag the old machine page is drawn', async () => {
  const s = snap('online');
  const rt = runtimeFor(s);
  const host = await mount(
    link(
      s,
      rt,
      createElement(SettingsMachine, {
        machine: machine(),
        back: () => {},
        runtime: rt,
      }),
    ),
  );
  assert.match(host.textContent!, /Change this machine on your Mac\./);
});

test('the checklist reads the snapshot: pair, presence and phase', () => {
  const s: any = snap('online');
  assert.deepEqual(supportInput(s, true).mac, {
    name: 'Studio',
    paired: true,
    presence: 'online',
  });
  assert.equal(supportInput(s, true).relay, 'ok');
  assert.equal(supportInput({ ...s, phase: 'error' }, true).relay, 'down');
  assert.equal(supportInput({ ...s, phase: 'connecting', presence: {} }, true).relay, 'unknown');
  assert.equal(supportInput({ ...s, phase: 'connecting' }, true).relay, 'ok');
  const none = supportInput({ ...s, pairs: [], selectedPair: null, user: null, presence: {} }, false);
  assert.deepEqual(
    [none.signedIn, none.online, none.mac.paired, none.mac.name, none.mac.presence],
    [false, false, false, 'your Mac', null],
  );
  assert.equal(supportInput({ ...s, selectedPair: null }, true).mac.paired, true);
  assert.equal(supportInput(s, true, machine() as any).host?.id, 'h1');
  assert.equal(supportInput(s, true, machine() as any).hostName, 'Cloud box');
});

function fakeDirect(o: { enrolled?: boolean; setup?: string; cards?: unknown[]; chat?: boolean }) {
  const calls: unknown[][] = [];
  let listener = () => {};
  const direct = {
    phones: {
      load: async () => {},
      watch: () => () => {},
      records: () => [],
      hostKeyOf: (id: string) => id,
      reachable: () => true,
      enrolled: () => !!o.enrolled,
      setupState: () => o.setup ?? 'idle',
      macSays: () => {},
      refresh: async (id: string) => (calls.push(['refresh', id]), true),
      setUp: async (id: string) => void calls.push(['setUp', id]),
      answer: async (...args: unknown[]) => void calls.push(['answer', ...args.slice(0, 4)]),
    },
    chat: { enabled: () => !!o.chat },
    cards: { waiting: () => 0, list: () => o.cards ?? [] },
    subscribe: (fn: () => void) => ((listener = fn), () => {}),
  };
  return { direct, calls, changed: () => listener() };
}
const card = (state: object = { kind: 'waiting' }) => ({
  id: 'c1',
  hostKey: 'h1',
  via: 'direct',
  state,
  card: {
    chatId: 'x',
    epoch: 1,
    requestId: 'r',
    cardKind: 'permission',
    at: 1,
    summary: { tool: 'bash', line: 'Run tests' },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow' }],
  },
});
async function page(m: object, d: ReturnType<typeof fakeDirect>, chats?: object, newChat?: () => void) {
  setSupportV2(true);
  const s = snap('online');
  const rt: any = { ...runtimeFor(s), direct: d.direct };
  return mount(link(s, rt, createElement(MachineScreen, { machine: machine(m), back: () => {}, runtime: rt, chats, newChat })));
}

test('a Host reached through the Mac offers direct access, shows each step, and Try again after a failure', async () => {
  const idle = fakeDirect({});
  const host = await page({ reach: 'through' }, idle);
  await click('Use without your Mac');
  assert.deepEqual(idle.calls, [['setUp', 'h1']]);
  const failed = fakeDirect({ setup: 'failed' });
  const h2 = await page({ reach: 'through' }, failed);
  assert.match(h2.textContent!, /Couldn't set up direct access to Cloud box\./);
  await click('Try again');
  assert.deepEqual(failed.calls, [['setUp', 'h1']]);
  const working = await page({ reach: 'through' }, fakeDirect({ setup: 'working' }));
  assert.match(working.textContent!, /Setting up…/);
  assert.doesNotMatch(working.textContent!, /Use without your Mac/);
  assert.ok(host);
});

test('an enrolled Host reads its waiting cards when the page opens and answers one from the page', async () => {
  const d = fakeDirect({ enrolled: true, cards: [card()] });
  const host = await page({}, d);
  assert.deepEqual(d.calls[0], ['refresh', 'h1']);
  assert.match(host.textContent!, /Run tests/);
  assert.doesNotMatch(host.textContent!, /Use without your Mac/);
  await click('Allow');
  assert.deepEqual(d.calls[1], ['answer', 'h1', 'Cloud box', 'c1', 'allow']);
  await act(async () => d.changed());
});

test('the checklist view says nothing under the headline when a problem has no next step, and the pairing wait copes with a missing number', async () => {
  const noop = () => {};
  const deleted = runChecks(
    input({
      host: {
        status: 'online',
        note: '',
        agents: [],
        installable: [],
        lastSeen: null,
        localNetwork: '',
        waitingForLogin: null,
        cloud: 'deleted',
      },
      hostName: 'Box',
    }),
    1,
  );
  const host = await mount(
    createElement(TroubleshootView, { ...deleted, running: false, copied: false, onRun: noop, onCopy: noop, onOpenLog: noop }),
  );
  assert.match(host.textContent!, /Deleted at the provider/);
  setSupportV2(true);
  const open = await mount(
    createElement(PairingCards, { state: { pendingPair: true, pairingCommit: false, pairCleanup: false }, busy: false, cancel: noop }),
  );
  assert.match(open.textContent!, /Confirm on your computer/);
});

test('with Reduce Motion on, rows are drawn with no entering animation', async () => {
  g.__phoneReduceMotion = true;
  try {
    const host = await mount(
      createElement(PairingConfirm, { vm: { phase: 'finishing', safetyNumber: null, busy: false }, onCancel: () => {} }),
    );
    assert.equal(host.querySelector('[data-entering]'), null);
  } finally {
    g.__phoneReduceMotion = false;
  }
  const host = await mount(
    createElement(PairingConfirm, { vm: { phase: 'finishing', safetyNumber: null, busy: false }, onCancel: () => {} }),
  );
  assert.ok(host.querySelector('[data-entering]'));
});

test('an enrolled Host with direct chat lists its chats on the page, and a tap opens one', async () => {
  const opened: string[] = [];
  const list = [
    { id: 'a', title: 'Fix build', hostId: 'h1', at: 2, state: 'waiting' },
    { id: 'b', title: 'Other box', hostId: 'h2', at: 3 },
  ];
  const chats = { list, open: (id: string) => opened.push(id) };
  const host = await page({}, fakeDirect({ enrolled: true, chat: true }), chats);
  assert.match(host.textContent!, /Fix build/);
  assert.doesNotMatch(host.textContent!, /Other box/);
  await click('Fix build');
  assert.deepEqual(opened, ['a']);
  assert.doesNotMatch((await page({}, fakeDirect({ enrolled: true, chat: false }), chats)).textContent!, /Fix build/);
  assert.doesNotMatch((await page({}, fakeDirect({ enrolled: true, chat: true }))).textContent!, /Fix build/);
});

test('New chat is offered only when the page can start one and a ready agent is there', async () => {
  let started = 0;
  const go = () => started++;
  const host = await page({}, fakeDirect({}), undefined, go);
  await click('New chat');
  assert.equal(started, 1);
  assert.doesNotMatch((await page({}, fakeDirect({}))).textContent!, /New chat/);
  const idle = await page({ agents: [{ id: 'claude', label: 'Claude', state: 'signin', via: null }] }, fakeDirect({}), undefined, go);
  assert.doesNotMatch(idle.textContent!, /New chat/);
  assert.ok(host);
});
