// The queue tray's states for messages kept for a remote machine (src/components/composer/QueuedList.tsx): why each waits, and what Send now says while the machine is away.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { stubStore } from './support/stubs.ts';
import { useFakeNative } from './support/ports/native.ts';

let queue: any[] = [];
let delivery: () => any = () => ({ status: 'queued', waitingFor: 'host' });
const notices: any[] = [];
mock.module('../src/store/session/useSession.ts', {
  namedExports: {
    useSession: () => ({ queue, turn: 'idle' }),
    useSessionField: (id: any, pick: any) => pick({ queue, turn: 'idle' }),
  },
});
const calls: unknown[][] = [];
let failWith: Error | null = null;
const act1 =
  (name: string) =>
  async (...args: unknown[]) => {
    calls.push([name, ...args]);
    if (failWith) throw failWith;
  };
mock.module('../src/lib/hostInstall.ts', { namedExports: { startInstall: act1('install'), installLine: () => '' } });
mock.module('../src/lib/hostSignin.ts', { namedExports: { startSignin: act1('signIn'), RUNNING: new Set<string>() } });
// the machine the refusals name: an older Host unless a test says otherwise
let listed: any[] = [{ id: 'box', name: 'mopilot-mini', status: 'online', agents: [], hostStale: true }];
mock.module('../src/lib/hostMachines.ts', { namedExports: { useHostMachines: () => ({ machines: listed }) } });
// the machine's folder picker, standing in for its modal: what it was opened with, and the choice or the cancel
const picker: { open: any } = { open: null };
mock.module('../src/components/composer/HostFolderPicker.tsx', {
  namedExports: {
    HostFolderPicker: (props: any) => {
      picker.open = props;
      return null;
    },
  },
});
let carried = true;
mock.module('../src/session/refusalNewChat.ts', {
  namedExports: {
    newChatWithMessage: async (...args: unknown[]) => {
      calls.push(['newChat', ...args]);
      return carried;
    },
  },
});
const removed: unknown[][] = [];
let owningTabs: any[] = [];
let recoveryTarget: string | undefined = 'fresh-child';
stubStore({
  removeQueued: async (...a: unknown[]) => (removed.push(a), true),
  sendQueuedNow: async () => delivery(),
  openSideChat: async (...args: unknown[]) => (calls.push(['openSideChat', ...args]), recoveryTarget),
  giveBackToComposer: (...args: unknown[]) => calls.push(['draft', ...args]),
  toast: (...args: any[]) => notices.push(args),
  useStore: Object.assign((sel: (s: any) => unknown) => sel({ authoredInputs: {} }), {
    getState: () => ({ paneTabs: owningTabs }),
  }),
});
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueuedList } = await import('../src/components/composer/QueuedList.tsx');

const msg = (id: string, text: string, waitingFor: string) => ({
  id,
  text,
  attachments: [],
  opts: {},
  origin: null,
  queuedAt: 0,
  waitingFor,
});
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement;
async function render(threadId = 'chat') {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(QueuedList, { threadId } as any)));
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  notices.length = 0;
});

test('messages kept for a machine say why they wait', async () => {
  queue = [
    msg('away', 'Machine is away', 'host'),
    { ...msg('checking', 'Check the first send', 'host'), pendingStart: true },
    msg('moved', 'Old owner', 'hostMoved'),
    msg('refused', 'Not taken', 'hostRefused'),
    msg('switching', 'Mid move', 'hostMoving'),
    { ...msg('switching-to', 'Named move', 'hostMoving'), movingTo: 'box-1' },
  ];
  await render();
  assert.match(host.textContent ?? '', /Waiting for host · Machine is away/);
  assert.match(host.textContent ?? '', /Delivery unconfirmed · Check the first send/);
  assert.match(host.textContent ?? '', /Chat moved to another machine · Old owner/);
  assert.match(host.textContent ?? '', /Host did not accept it · Not taken/);
  assert.match(host.textContent ?? '', /Waiting for the switch · Mid move/);
  assert.match(host.textContent ?? '', /Waiting for the switch to box-1 · Named move/);
});

test('a later policy refusal leaves recovery available for an unconfirmed side-chat start', async () => {
  const id = `acp:kimi:side-chat-${crypto.randomUUID()}`;
  const attachments = [
    { kind: 'image', path: '/tmp/marked.png', name: 'marked' },
    { kind: 'selection', text: 'note' },
  ];
  owningTabs = [{ kind: 'chat', threadId: id, sourceChatId: 'parent' }];
  calls.length = 0;
  const removedBefore = removed.length;
  queue = [
    {
      ...msg('unsure', 'Review the marks', 'hostRefused'),
      attachments,
      pendingStart: true,
      error: 'The machine now requires approval.',
      refusal: { code: 'policy_refused', action: 'useMode', retry: false, mode: 'read-only' },
    },
  ];
  await render(id);
  assert.match(host.textContent ?? '', /Delivery unconfirmed: The machine now requires approval\./);
  assert.equal(host.querySelector('button[aria-label="Remove from queue"]'), null);
  const chooseRecovery = async (repeated = false) => {
    await act(async () => (host.querySelector('button[aria-label="Queued message actions"]') as HTMLButtonElement).click());
    const recover = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((node) => node.textContent === 'Recover as draft');
    assert.ok(recover);
    await act(async () => {
      recover.click();
      if (repeated) recover.click();
    });
  };
  await chooseRecovery(true);
  assert.deepEqual(calls, [
    ['openSideChat', 'parent', undefined, undefined, { recoveryFrom: id }],
    ['draft', 'fresh-child', 'Review the marks', attachments],
  ]);
  assert.equal(removed.length, removedBefore);
  recoveryTarget = undefined;
  calls.length = 0;
  await chooseRecovery();
  assert.deepEqual(calls, [['openSideChat', 'parent', undefined, undefined, { recoveryFrom: id }]]);
  owningTabs = [];
  calls.length = 0;
  await chooseRecovery();
  assert.deepEqual(calls, []);
  assert.match(notices[0]?.[0] ?? '', /Open the parent chat/);
});

test('a message the Host refused says why, in the Host\u2019s words, on its row', async () => {
  queue = [{ ...msg('refused', 'Not taken', 'hostRefused'), error: "Couldn't start Claude Code: no such binary." }];
  await render();
  assert.match(host.textContent ?? '', /Host did not accept it: Couldn't start Claude Code: no such binary\. · Not taken/);
  // the way to send it again says Retry, as for any message that did not go
  assert.ok(host.querySelector('button[aria-label="Retry"]'));
});

test('a pending first start still offers sign-in when the Host says its login expired', async () => {
  calls.length = 0;
  queue = [
    {
      ...msg('sign-in', 'Keep the original', 'hostRefused'),
      pendingStart: true,
      refusal: { code: 'login_signed_out', action: 'signIn', retry: true, hostId: 'box', agent: 'codex' },
    },
  ];
  await render();
  const signIn = host.querySelector<HTMLButtonElement>('button[aria-label="Sign in"]');
  assert.ok(signIn);
  await act(async () => signIn.click());
  assert.deepEqual(calls, [['signIn', 'box', 'codex']]);
  assert.equal(host.querySelector('button[aria-label="Remove from queue"]'), null);
});

test('a refusal whose sentence already names the cause is not fronted with "Host did not accept it"', async () => {
  queue = [
    {
      ...msg('named', 'Mode', 'hostRefused'),
      error: 'Ask for approval is not allowed on box. The most it allows is Read-only.',
      refusal: { code: 'policy_refused', action: 'useMode', retry: false, hostId: 'box', machine: 'box', named: true },
    },
  ];
  await render();
  const text = host.textContent ?? '';
  assert.match(text, /Ask for approval is not allowed on box\. The most it allows is Read-only\. · Mode/);
  assert.doesNotMatch(text, /Host did not accept it/);
});

test('a message this app refused before the Host saw it says what it is and the fix, never that the Host did not accept it', async () => {
  const own = {
    ...msg('own', 'Too big', 'hostRefused'),
    error: 'big.bin is larger than 25 MB. Remove it or send a smaller one.',
    refusal: { code: 'unsupported', action: null, retry: false, hostId: 'box', machine: 'box', own: true },
  };
  queue = [own, { ...own, id: 'host', refusal: { ...own.refusal, own: false } }];
  await render();
  const text = host.textContent ?? '';
  assert.match(text, /big\.bin is larger than 25 MB\. Remove it or send a smaller one\. · Too big/);
  assert.equal(text.match(/Host did not accept it/g)?.length, 1, 'only the row the Host refused carries the prefix');
  assert.ok(host.querySelector('button[aria-label="Remove from queue"]'));
});

test('a message the Host took into its running turn shows as sent, with no Send that would send it twice (#5141)', async () => {
  queue = [{ ...msg('taken', 'Also say done', ''), waitingFor: undefined, steered: true } as any, msg('away', 'Machine is away', 'host')];
  await render();
  const rows = [...host.querySelectorAll('.queue-row')];
  assert.equal(rows[0].querySelector('.queue-steer'), null);
  assert.ok(rows[1].querySelector('.queue-steer'));
  assert.match(rows[0].textContent ?? '', /Also say done/);
});

test('Send now on a message waiting for the machine says it is not reachable yet', async () => {
  queue = [msg('away', 'Machine is away', 'host')];
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>('.queue-steer')!.click());
  assert.deepEqual(notices.pop(), ['The host is not reachable yet. This message will send when it is.', 'info']);
});

test('a message that waits for the organization sign-in says so; Sign in signs in once, even on a double click, and a failure is a toast', async (t) => {
  let finish: (v?: unknown) => void = () => undefined;
  let outcome: 'wait' | 'fail' = 'wait';
  const fake = useFakeNative(t, {
    host: { orgSignIn: () => (outcome === 'fail' ? Promise.reject(new Error('The IdP refused.')) : new Promise((r) => (finish = r))) },
  });
  queue = [msg('org', 'Needs sign-in', 'orgSignin')];
  await render();
  assert.match(host.textContent ?? '', /Organization sign-in needed · Needs sign-in/);
  const button = () => host.querySelector<HTMLButtonElement>('.queue-steer')!;
  assert.equal(button().textContent, 'Sign in');
  await act(async () => {
    button().click();
    button().click();
  });
  assert.equal(fake.callsTo('host.orgSignIn').length, 1);
  assert.equal(button().disabled, true, 'busy while it is pending');
  await act(async () => finish());
  assert.equal(button().disabled, false);
  assert.deepEqual(notices, []);
  outcome = 'fail';
  await act(async () => button().click());
  assert.deepEqual(notices.pop(), ['Could not sign in: The IdP refused.', 'error']);
});

const refused = (refusal: object, error = 'Why it was refused.') => [{ ...msg('refused', 'Not taken', 'hostRefused'), error, refusal }];
const REFUSAL = { code: 'harness_not_configured', action: null, retry: false, hostId: 'box', machine: 'mopilot-mini', agent: 'codex' };
const mainButton = () => host.querySelector<HTMLButtonElement>('.queue-steer');

test('a refusal with an action offers that action in place of Retry, naming the machine where it is on it', async () => {
  const labels: [string, string][] = [
    ['install', 'Install on mopilot-mini'],
    ['signIn', 'Sign in'],
    ['orgSignIn', 'Sign in'],
    ['update', 'Update'],
    ['openMachines', 'Machine settings'],
    ['newChat', 'New chat on mopilot-mini'],
    ['chooseFolder', 'Choose a folder'],
  ];
  for (const [action, label] of labels) {
    queue = refused({ ...REFUSAL, action });
    await render();
    assert.equal(mainButton()?.getAttribute('aria-label'), label, action);
    assert.equal(host.querySelector('button[aria-label="Retry"]'), null, `${action}: no Retry while Retry cannot succeed`);
    await act(async () => root!.unmount());
    root = null;
    host.remove();
  }
});

test('each action does what it says once, even on a double click: install and sign in on the machine, the organization sign-in, update the Host', async (t) => {
  useFakeNative(t, {
    host: { update: async (id: string) => void calls.push(['update', id]), orgSignIn: async () => void calls.push(['orgSignIn']) },
  });
  const expected: Record<string, unknown[]> = {
    install: ['install', 'box', 'codex'],
    signIn: ['signIn', 'box', 'codex'],
    orgSignIn: ['orgSignIn'],
    update: ['update', 'box'],
  };
  for (const action of Object.keys(expected)) {
    calls.length = 0;
    queue = refused({ ...REFUSAL, action });
    await render();
    await act(async () => {
      mainButton()!.click();
      mainButton()!.click();
    });
    await act(async () => undefined);
    assert.deepEqual(calls, [expected[action]], action);
    await act(async () => root!.unmount());
    root = null;
    host.remove();
  }
});

test('a fix and Retry together: the fix first, then Retry sends the same message; the fix alone when Retry cannot succeed yet', async () => {
  calls.length = 0;
  queue = refused({ ...REFUSAL, action: 'update', retry: true });
  await render();
  const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('.queue-steer')].map((b) => b.getAttribute('aria-label'));
  assert.deepEqual(buttons(), ['Update', 'Retry']);
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Retry"]')!.click());
  assert.equal(calls.length, 0, 'Retry does not run the fix');
  await act(async () => root!.unmount());
  root = null;
  host.remove();
  queue = refused({ ...REFUSAL, action: 'update', retry: false });
  await render();
  assert.deepEqual(buttons(), ['Update']);
});

test('New chat on the machine carries the message and takes the row out of the queue; with no chat started the row stays', async () => {
  for (const started of [true, false]) {
    calls.length = 0;
    removed.length = 0;
    carried = started;
    queue = refused({ ...REFUSAL, code: 'chat_unknown', action: 'newChat' });
    await render();
    await act(async () => mainButton()!.click());
    await act(async () => undefined);
    assert.equal(calls.length, 1);
    const [name, refusal, carriedMessage] = calls[0] as [string, object, { removeRow: unknown }];
    const { removeRow, ...fields } = carriedMessage;
    assert.deepEqual(
      [name, refusal, fields],
      [
        'newChat',
        { ...REFUSAL, code: 'chat_unknown', action: 'newChat' },
        { chatId: 'chat', text: 'Not taken', attachments: [], opts: {} },
      ],
    );
    assert.equal(typeof removeRow, 'function');
    assert.deepEqual(removed, started ? [['chat', 'refused']] : []);
    await act(async () => root!.unmount());
    root = null;
    host.remove();
  }
  carried = true;
});

test('Choose a folder opens the machine\u2019s folder picker first; the folder picked starts the new chat there and the row goes, and closing the picker starts nothing', async () => {
  const folderRefusal = { ...REFUSAL, code: 'directory_missing', action: 'chooseFolder', retry: true };
  queue = refused(folderRefusal);
  carried = true;
  calls.length = 0;
  removed.length = 0;
  picker.open = null;
  await render();
  assert.deepEqual(
    [...host.querySelectorAll<HTMLButtonElement>('.queue-steer')].map((b) => b.getAttribute('aria-label')),
    ['Choose a folder', 'Retry'],
  );
  await act(async () => mainButton()!.click());
  assert.equal(picker.open.hostId, 'box');
  assert.equal(picker.open.name, 'mopilot-mini');
  assert.deepEqual(calls, [], 'nothing starts until a folder is picked');
  // closed without a folder: nothing started, nothing removed
  await act(async () => picker.open.onClose());
  assert.deepEqual([calls, removed], [[], []]);
  await act(async () => mainButton()!.click());
  await act(async () => picker.open.onPick('/srv/other'));
  await act(async () => undefined);
  assert.equal(calls.length, 1);
  const [name, refusal, carriedMessage, folder] = calls[0] as [string, object, { removeRow: unknown }, string];
  assert.deepEqual([name, refusal, folder], ['newChat', folderRefusal, '/srv/other']);
  assert.equal(typeof carriedMessage.removeRow, 'function');
  assert.deepEqual(removed, [['chat', 'refused']]);
});

test('an action that fails says so in a toast and leaves the row as it was', async () => {
  failWith = new Error('The machine did not answer.');
  queue = refused({ ...REFUSAL, action: 'install' });
  await render();
  await act(async () => mainButton()!.click());
  await act(async () => undefined);
  assert.match(String(notices.pop()?.[0]), /^Install on mopilot-mini failed: .*did not answer/);
  assert.equal(mainButton()?.getAttribute('aria-label'), 'Install on mopilot-mini');
  failWith = null;
});

test('Retry only where sending again can succeed: a refusal that needs something else first has no Retry, and the row can still be removed or copied', async () => {
  queue = refused({ ...REFUSAL, retry: true });
  await render();
  assert.ok(host.querySelector('button[aria-label="Retry"]'));
  await act(async () => root!.unmount());
  root = null;
  host.remove();
  queue = refused({ ...REFUSAL, retry: false });
  await render();
  assert.equal(mainButton(), null);
  assert.match(host.textContent ?? '', /Host did not accept it: Why it was refused\. · Not taken/);
  assert.ok(host.querySelector('button[aria-label="Remove from queue"]'));
  assert.ok(host.querySelector('button[aria-label="Queued message actions"]'));
});

test('an Update that cannot work from here is not offered, as in the machine row: a newer Host and a machine added by command say why, an unlisted machine offers none', async () => {
  const cases: [any[], RegExp | null][] = [
    [[{ id: 'box', name: 'mopilot-mini', status: 'online', agents: [], hostNewer: true }], /Host is newer · Update MoPilot/],
    [[{ id: 'relay:box', name: 'mopilot-mini', status: 'online', agents: [], hostStale: true }], /Update it on the machine/],
    [[], null],
  ];
  for (const [machines, words] of cases) {
    listed = machines;
    queue = refused({ ...REFUSAL, action: 'update', retry: true, hostId: machines[0]?.id ?? 'box' });
    await render();
    assert.equal(host.querySelector('button[aria-label="Update"]'), null);
    assert.deepEqual(
      [...host.querySelectorAll('.queue-steer')].map((b) => b.getAttribute('aria-label')),
      ['Retry'],
    );
    if (words) assert.match(host.querySelector('.host-update-note')?.textContent ?? '', words);
    else assert.equal(host.querySelector('.host-update-note'), null);
    await act(async () => root!.unmount());
    root = null;
    host.remove();
  }
  listed = [{ id: 'box', name: 'mopilot-mini', status: 'online', agents: [], hostStale: true }];
});

test('a refusal whose sentence names the cause is not fronted by "Host did not accept it"', async () => {
  queue = refused(
    { ...REFUSAL, code: 'unknown_client', action: 'openMachines', retry: true, named: true },
    "mopilot-mini doesn't know this Mac.",
  );
  await render();
  assert.match(host.textContent ?? '', /^mopilot-mini doesn't know this Mac\. · Not taken/);
  assert.equal(mainButton()?.getAttribute('aria-label'), 'Pair again');
});
