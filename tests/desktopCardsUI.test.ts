// The desktop control cards, rendered in happy-dom: the access card (apps at their tiers, warnings,
// what can't be granted, extras, unchecking apps) and the takeover card (Approvals.tsx), and the
// permission onboarding card (ComputerPermissionCard.tsx). native.computer (IPC) and the store are
// mocked; only trusted input (a person's) answers a card.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { controlledReads, deferred } from './support/async-scenarios';
import * as react from 'react';
import { iconStubs, mockSource, popoverStubs, taggedIcon, withStoreSlices } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const fx: any = {
  calls: [] as any[],
  approvals: [] as any[],
  pending: [] as any[],
  status: async () => ({ permissions: {} }),
  recheck: async () => true,
  requestPermission: async () => ({}),
  onChanged: undefined as any,
};

const f = fx;
const nul = () => null;
const stubs: Record<string, Record<string, unknown>> = {
  store: {
    useStore: (s: any) => s({ segments: {}, runtime: {} }),
    resolveRequest: () => {},
    interrupt: async () => {},
    sendOrDraft: async () => {},
    toastFailure: () => () => {},
    chatHarnessLabel: () => 'Claude Code',
    chatOf: (x: any) => x,
    toast: () => {},
  },
  'harness/copy.ts': { copy: (ns: string, key: string, vars: any) => `${ns}.${key}[${vars?.Harness ?? vars?.Permission ?? ''}]` },
  'components/ui/icons.tsx': iconStubs(taggedIcon),
  'lib/format.ts': { prettyCommand: (x: any) => String(x) },
  'lib/paths.ts': { relPath: (x: any) => x },
  'session/open.ts': { openLink: nul },
  'components/diff/DiffView.tsx': { InlineDiff: nul, fileChangeToDiff: nul },
  'components/ui/Popover.tsx': popoverStubs(),
  'harness/acpTranslate.ts': { permissionChoices: () => [], toolItem: nul },
  'store/session/useSession.ts': { useSession: () => ({ approvals: fx.approvals }) },
  'harness/approvalRequests.ts': { requestsOf: () => fx.pending },
  'harness/elicitation.ts': {
    elicitationAnswer: nul,
    nativeAppAnswer: nul,
    nativeAppApproval: nul,
    browserUseApproval: nul,
    browserUseAnswer: nul,
    allowsAllSites: () => false,
  },
  'harness/chromeApproval.ts': { chromeApproval: nul, chromeSuggestion: nul, chromeTabUrl: nul, chromeTool: nul },
  'harness/adapters/codexApi.ts': { codexApi: { configRequirementsRead: async () => null } },
  'session/harness/acp.ts': { acpLabelOf: (x: any) => x },
  'lib/focus.ts': { isEnter: (e: any) => e.key === 'Enter' },
  'components/thread/QuestionCard.tsx': { QuestionCard: () => react.createElement('div', { className: 'question-card' }, 'question') },
  'components/thread/approvals/autoSwitch.tsx': { AutoSwitchItem: nul },
};
const bridge: any = {
  computer: {
    answer: (...a: any[]) => (f.calls.push(['answer', ...a]), Promise.resolve(true)),
    status: (...a: any[]) => (f.calls.push(['status', ...a]), f.status()),
    recheck: (...a: any[]) => (f.calls.push(['recheck', ...a]), f.recheck(...a)),
    requestPermission: (...a: any[]) => (f.calls.push(['requestPermission', ...a]), f.requestPermission(...a)),
    openSettings: (...a: any[]) => (f.calls.push(['openSettings', ...a]), Promise.resolve(true)),
    get onChanged() {
      return f.onChanged;
    },
  },
};
installNativeStub(bridge); // the bridge the modules read, in the native port (src/lib/native.ts)
for (const [rel, exports] of Object.entries(withStoreSlices(stubs))) mockSource(`src/${rel}`, exports);
const { act, createElement } = react;
const { createRoot } = await import('react-dom/client');
const { Approvals } = await import('../src/components/thread/Approvals.tsx');
const { ComputerPermissionCard, permissionRows } = await import('../src/components/thread/ComputerPermissionCard.tsx');

let root: any;
let container: HTMLElement;
async function render(el: any) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(el));
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = null;
  container?.remove();
  document.querySelectorAll('.popover-layer').forEach((n) => n.remove());
  fx.calls = [];
  fx.approvals = [];
  fx.pending = [];
  fx.onChanged = undefined;
  fx.status = async () => ({ permissions: {} });
  fx.recheck = async () => true;
  fx.requestPermission = async () => ({});
});

const trusted = <T extends Event>(e: T, value = true) => (Object.defineProperty(e, 'isTrusted', { value }), e);
async function click(el: Element | null | undefined, isTrusted = true) {
  assert.ok(el, 'element exists');
  await act(async () => {
    el!.dispatchEvent(trusted(new window.MouseEvent('click', { bubbles: true, cancelable: true }) as any, isTrusted));
  });
}
async function key(k: string, o: { target?: Element; isTrusted?: boolean } = {}) {
  const ev = trusted(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }) as any, o.isTrusted ?? true);
  await act(async () => {
    (o.target ?? document.body).dispatchEvent(ev);
  });
  return ev;
}
const button = (label: RegExp) => [...container.querySelectorAll('button')].find((b) => label.test(b.textContent ?? ''));
const answers = () => fx.calls.filter((c: any[]) => c[0] === 'answer').map((c: any[]) => c.slice(1));
const card = (params: any, id = 'sage-1') => ({ id, method: `sage/${params.kind}`, params });
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

const NOTES = { bundleId: 'com.apple.Notes', name: 'Notes', tier: 'full', tierLabel: 'Full control', warning: null };
const TERMINAL = {
  bundleId: 'com.apple.Terminal',
  name: 'Terminal',
  tier: 'click',
  tierLabel: 'Click and scroll',
  warning: 'A terminal can run any command on this Mac.',
};

/* -- the access card ------------------------------------------------------ */
test('access card: each app at its tier with warnings, what is not available, extras; Allow grants the checked apps', async () => {
  fx.approvals = [
    card({
      kind: 'computerAccessSet',
      harness: 'claude',
      apps: [NOTES, { ...TERMINAL, tierLabel: undefined }],
      denied: [{ name: 'MoPilot', reason: 'never granted' }],
      reason: 'Write the release notes',
      clipboardRead: true,
      clipboardWrite: false,
      systemKeyCombos: true,
    }),
  ];
  await render(createElement(Approvals, { threadId: 't1', cwd: '/p' }));
  const el = container.querySelector('.desktop-access')!;
  assert.equal(el.getAttribute('data-kind'), 'computerAccessSet');
  // one sentence; the task, the apps and the fine print behind Details
  assert.equal(
    container.querySelector('.approval-message')!.textContent,
    'Allow Claude Code to use Notes and Terminal and read the clipboard and press whole-Mac shortcuts?',
  );
  const details = el.querySelector('details.desktop-access-details')!;
  assert.equal(details.querySelector('summary')!.textContent, 'Details');
  assert.match(details.textContent!, /“Write the release notes”/);
  // the broad-reach warning stays visible, as one line outside Details
  const warning = el.querySelector(':scope .approval-top > .desktop-access-warning')!;
  assert.match(warning.textContent!, /^ ?Terminal: .*run any command/);
  const rows = [...el.querySelectorAll('.desktop-access-apps li')];
  assert.deepEqual(
    rows.map((r) => [
      r.querySelector('.desktop-access-name')!.textContent,
      r.querySelector('.desktop-access-tier')!.textContent,
      r.querySelector('.desktop-access-tier')!.getAttribute('data-tier'),
    ]),
    [
      ['Notes', 'Full control', 'full'],
      ['Terminal', 'click', 'click'],
    ],
  );
  assert.equal(el.querySelector('.desktop-access-control'), null, 'no takeover checkbox');
  assert.match(el.textContent!, /Not available: MoPilot \(never granted\)\./);
  assert.ok([...el.querySelectorAll('input[type=checkbox]')].every((c: any) => c.checked));
  // a script's click does nothing; a person's click allows
  await click(button(/^Allow/), false);
  assert.deepEqual(answers(), []);
  await click(button(/^Allow/));
  assert.deepEqual(answers(), [
    [
      'sage-1',
      {
        decision: 'allow',
        apps: ['com.apple.Notes', 'com.apple.Terminal'],
        clipboardRead: true,
        clipboardWrite: false,
        systemKeyCombos: true,
      },
    ],
  ]);
});

test('access card: unchecking leaves an app out; none checked disables Allow and Enter; Esc denies', async () => {
  fx.approvals = [card({ kind: 'computerAccessSet', harness: 'claude', apps: [NOTES, TERMINAL] })];
  await render(createElement(Approvals, { threadId: 't1', cwd: '/p' }));
  const boxes = [...container.querySelectorAll('input[type=checkbox]')] as HTMLInputElement[];
  await click(boxes[1], false);
  assert.equal(boxes[1].checked, true, 'only a person unchecks');
  await click(boxes[1]);
  assert.equal(boxes[1].checked, false);
  await key('Enter');
  assert.deepEqual(answers()[0][1].apps, ['com.apple.Notes']);
  await click(boxes[0]);
  await click(boxes[1]);
  await click(boxes[1]);
  assert.equal((button(/^Allow/) as HTMLButtonElement).disabled, true);
  fx.calls = [];
  await key('Enter');
  await key('1');
  assert.deepEqual(answers(), [], 'nothing to allow');
  await key('Escape');
  assert.deepEqual(answers(), [['sage-1', { decision: 'deny' }]]);
  await click(button(/^Deny/));
  assert.equal(answers().length, 2);
  // no reason, no denied list, no extras: none of those lines
  assert.doesNotMatch(container.textContent!, /“|Not available|Also:/);
});

bridge.computer.appIdentity = async () => ({ name: 'Notes', bundleId: null, icon: 'data:image/png;base64,QQ==' }); // names apps from here on
test('access card: one app is named; extras alone say what they are for', async () => {
  fx.approvals = [card({ kind: 'computerAccessSet', harness: 'claude', apps: [NOTES] })];
  await render(createElement(Approvals, { threadId: 't1', cwd: '/p' }));
  assert.equal(container.querySelector('.approval-message')!.textContent, 'Allow Claude Code to use Notes?');
  await flush(); // main names the one app: its icon leads the question (Claude Design 4A)
  assert.equal(container.querySelector('img.desktop-access-icon')?.getAttribute('src'), 'data:image/png;base64,QQ==');
  assert.equal(container.querySelector('.approval-top > .desktop-access-warning'), null, 'no warning line without a warning');
  await act(async () => root.unmount());
  fx.approvals = [card({ kind: 'computerAccessSet', harness: 'claude', clipboardRead: true, clipboardWrite: true })];
  await render(createElement(Approvals, { threadId: 't1', cwd: '/p' }));
  assert.equal(
    container.querySelector('.approval-message')!.textContent,
    'Allow Claude Code to read the clipboard and write the clipboard?',
  );
  assert.equal(container.querySelector('.desktop-access-apps') === null, true);
  assert.doesNotMatch(container.textContent!, /Also:/, 'the extras are the message');
  assert.equal((button(/^Allow/) as HTMLButtonElement).disabled, false);
  await key('1');
  assert.deepEqual(answers(), [
    ['sage-1', { decision: 'allow', apps: [], clipboardRead: true, clipboardWrite: true, systemKeyCombos: undefined }],
  ]);
});

test("access card: Always allow (its own button) remembers the checked apps (a person's click only); Enter, 1 and Allow stay for this chat", async () => {
  fx.approvals = [card({ kind: 'computerAccessSet', harness: 'codex', apps: [NOTES, TERMINAL], clipboardRead: true })];
  await render(createElement(Approvals, { threadId: 't1', cwd: '/p' }));
  assert.match(container.querySelector('.desktop-access')!.textContent!, /Browsers are view only; terminals and editors, click only\./);
  assert.doesNotMatch(container.querySelector('.desktop-access')!.textContent!, /Access lasts for this chat/);
  // the tier line stays in Details; Deny, Always allow and the primary are each their own button (Claude Design 4A)
  assert.deepEqual(
    [...container.querySelectorAll('.approval-foot button')].map((b) => b.textContent!.replace(/\s+/g, ' ').trim()),
    ['Deny Esc', 'Always allow', 'Allow in this chat ⏎'],
  );
  // Enter and 1 are the per-chat Allow, never Always allow
  await key('Enter');
  await key('1');
  assert.deepEqual(
    answers().map((a: any[]) => a[1].remember),
    [undefined, undefined],
  );
  fx.calls = []; // a script's click does nothing; a person's Always allow remembers the checked apps
  const always = button(/^Always allow/)!;
  await click(always, false);
  assert.equal(answers().length, 0);
  await click(container.querySelectorAll('.desktop-access-apps input[type=checkbox]')[1]);
  await click(always);
  assert.deepEqual(answers(), [
    [
      'sage-1',
      {
        decision: 'allow',
        apps: ['com.apple.Notes'],
        clipboardRead: true,
        clipboardWrite: undefined,
        systemKeyCombos: undefined,
        remember: true,
      },
    ],
  ]);
  // the per-chat Allow button never remembers
  fx.calls = [];
  await click(button(/^Allow in this chat/)!);
  assert.equal(answers()[0][1].remember, undefined);
  await click(container.querySelectorAll('.desktop-access-apps input[type=checkbox]')[0]);
  assert.equal((button(/^Allow in this chat/) as HTMLButtonElement).disabled, true);
  assert.equal(container.querySelector('.approval-foot .chevron'), null);
  fx.calls = [];
  await key('Enter');
  assert.deepEqual(answers(), []);
});

test('access card: no Always allow when only the clipboard or shortcuts are asked, or on the takeover card', async () => {
  fx.approvals = [card({ kind: 'computerAccessSet', harness: 'claude', clipboardWrite: true })];
  await render(createElement(Approvals, { threadId: 't1', cwd: '/p' }));
  assert.equal(button(/^Always allow/), undefined);
  assert.match(container.querySelector('.desktop-access-details')!.textContent!, /terminals and editors, click only\.$/);
  await act(async () => root.unmount());
  fx.approvals = [card({ kind: 'computerTakeover', harness: 'claude', apps: [NOTES] })];
  await render(createElement(Approvals, { threadId: 't1', cwd: '/p' }));
  assert.equal(button(/^Always allow/), undefined);
});

/* -- the takeover card ---------------------------------------------------- */
test('takeover card: asks once to control the screen; Enter or 1 allows, Esc denies; typing, menus and other cards keep their keys', async () => {
  fx.approvals = [card({ kind: 'computerTakeover', harness: 'claude', apps: [NOTES] }, 'sage-2')];
  await render(createElement(Approvals, { threadId: 't1', cwd: '/p' }));
  assert.match(container.querySelector('.approval-message')!.textContent!, /^Allow Claude Code to use your mouse and keyboard in Notes\?$/);
  assert.equal(container.querySelector('.desktop-access-details'), null);
  assert.equal(container.querySelector('.desktop-access-why'), null, 'no reason given: no reason line');
  assert.match(button(/^Allow/)!.textContent!, /^Allow/);
  // keys that are not the card's
  const input = document.createElement('input');
  document.body.append(input);
  await key('Enter', { target: input });
  input.remove();
  const layer = document.createElement('div');
  layer.className = 'popover-layer';
  document.body.append(layer);
  await key('Enter');
  layer.remove();
  const other = document.createElement('div');
  other.className = 'approval-card';
  document.body.append(other);
  await key('Enter', { target: other });
  other.remove();
  await key('Enter', { isTrusted: false });
  await key('x');
  // a key another handler already took
  await act(async () => {
    const ev = trusted(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }) as any);
    ev.preventDefault();
    document.body.dispatchEvent(ev);
  });
  assert.deepEqual(answers(), []);
  await key('Enter');
  await key('1');
  await click(button(/^Allow/));
  assert.deepEqual(answers(), [
    ['sage-2', { decision: 'allow' }],
    ['sage-2', { decision: 'allow' }],
    ['sage-2', { decision: 'allow' }],
  ]);
  await key('Escape');
  assert.deepEqual(answers().at(-1), ['sage-2', { decision: 'deny' }]);
});

test('Approvals: a harness request comes first; other Sage cards keep their own card; a queue counts the rest', async () => {
  fx.pending = [{ id: 'r1', method: 'item/tool/requestUserInput', params: {} }];
  fx.approvals = [card({ kind: 'computerTakeover', harness: 'claude', apps: [] })];
  await render(createElement(Approvals, { threadId: 't1', cwd: '/p' }));
  assert.ok(container.querySelector('.question-card'));
  assert.equal(container.querySelector('.desktop-access') === null, true);
  assert.equal(container.querySelector('.approval-queue')!.textContent, '1 more waiting');
  await act(async () => root.unmount());
  fx.pending = [];
  fx.approvals = [
    card({
      kind: 'computerConfirm',
      harness: 'claude',
      app: { bundleId: 'com.apple.Notes', name: 'Notes' },
      verb: 'send',
      summary: 'Send',
    }),
  ];
  await render(createElement(Approvals, { threadId: 't1', cwd: '/p' }));
  assert.equal(container.querySelector('.desktop-access') === null, true);
  assert.equal(container.querySelector('.approval-message')!.textContent, "Allow Claude Code to send in Notes? This can't be undone.");
  assert.equal(container.querySelector('.sage-access-hint')!.textContent, 'Send');
  await act(async () => root.unmount());
  fx.approvals = [];
  await render(createElement(Approvals, { threadId: 't1', cwd: '/p' }));
  assert.equal(container.innerHTML, '');
});

/* -- the permission card --------------------------------------------------- */
test('permission rows: Accessibility and Screen Recording always, Input Monitoring only when it is the missing one', () => {
  assert.deepEqual(
    permissionRows('accessibility').map((r: any) => r.id),
    ['accessibility', 'screenRecording'],
  );
  assert.deepEqual(
    permissionRows('screenRecording').map((r: any) => r.id),
    ['accessibility', 'screenRecording'],
  );
  assert.deepEqual(
    permissionRows('inputMonitoring').map((r: any) => r.id),
    ['accessibility', 'screenRecording', 'inputMonitoring'],
  );
});

test('permission card: each permission with its state; the missing one can be requested; Try again looks again', async () => {
  fx.status = async () => ({ permissions: { accessibility: false, screenRecording: true } });
  await render(createElement(ComputerPermissionCard, { threadId: 't1', permission: 'accessibility' }));
  await flush();
  const el = container.querySelector('.cu-permission')!;
  assert.equal(el.getAttribute('data-permission'), 'accessibility');
  assert.equal(el.getAttribute('role'), 'alert');
  assert.match(el.textContent!, /computerUse\.permissionAccessibility\[Claude Code\]/);
  const rows = [...el.querySelectorAll('.cu-onboarding-rows li')];
  assert.deepEqual(
    rows.map((r) => [r.querySelector('b')!.textContent, r.getAttribute('data-granted')]),
    [
      ['Accessibility', 'false'],
      ['Screen Recording', 'true'],
    ],
  );
  assert.ok(rows[1].querySelector('[data-icon=Check]'));
  assert.equal(rows[1].querySelectorAll('button').length, 0, 'a granted permission needs nothing');
  assert.deepEqual(
    [...rows[0].querySelectorAll('button')].map((b) => b.textContent),
    ['Request', 'computerUse.openSystemSettings[]'],
  );
  // a script's clicks do nothing
  await click(rows[0].querySelector('button'), false);
  await click(rows[0].querySelectorAll('button')[1], false);
  await click(button(/^Try again/), false);
  assert.deepEqual(
    fx.calls.map((c: any[]) => c[0]),
    ['status'],
  );
  // Request: the macOS prompt, then a look again; the rows refresh
  fx.status = async () => ({ permissions: { accessibility: true, screenRecording: true } });
  await click(rows[0].querySelector('button'));
  await flush();
  assert.deepEqual(
    fx.calls.slice(1).map((c: any[]) => c.slice(0, 2)),
    [['requestPermission', 'accessibility'], ['recheck', 't1'], ['status']],
  );
  // the missing permission stays a row to act on even if the status says otherwise (main takes the card down)
  assert.equal(el.querySelector('li')!.getAttribute('data-granted'), 'false');
  fx.calls = [];
  await click(el.querySelector('li')!.querySelectorAll('button')[1]);
  assert.deepEqual(fx.calls, [['openSettings', 'accessibility']]);
  fx.calls = [];
  await click(button(/^Try again/));
  await flush();
  assert.deepEqual(
    fx.calls.map((c: any[]) => c.slice(0, 2)),
    [['recheck', 't1'], ['status']],
  );
});

test('permission card: Input Monitoring, a status without permissions, and failures that keep the card', async () => {
  fx.status = async () => ({});
  await render(createElement(ComputerPermissionCard, { threadId: 't1', permission: 'inputMonitoring' }));
  await flush();
  const rows = [...container.querySelectorAll('.cu-onboarding-rows li')];
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.getAttribute('data-granted') === 'false'));
  assert.equal(rows[2].querySelectorAll('button')[0].textContent, 'Request');
  assert.equal(rows[0].querySelectorAll('button').length, 1, 'only Open System Settings for a row that is not the missing one');
  // Try again failing: the card stays, and the buttons come back
  fx.recheck = async () => {
    throw new Error('helper gone');
  };
  const again = button(/^Try again/) as HTMLButtonElement;
  const failure = () => container.querySelector('.cu-permission .config-warning')?.textContent;
  await click(again);
  await flush();
  assert.equal(again.disabled, false);
  assert.equal(failure(), "Couldn't check the permissions: helper gone", 'a look again that failed says so');
  // the status failing after a look again keeps what was shown, and says so
  fx.recheck = async () => true;
  fx.status = async () => {
    throw new Error('gone');
  };
  await click(again);
  await flush();
  assert.equal(again.disabled, false);
  assert.equal(container.querySelectorAll('.cu-onboarding-rows li').length, 3);
  assert.equal(failure(), "Couldn't check the permissions: gone");
  // a status without permissions after a look again: nothing is shown as granted any more
  fx.status = async () => ({ permissions: { accessibility: true } });
  await click(again);
  await flush();
  assert.equal(container.querySelector('.cu-onboarding-rows li')!.getAttribute('data-granted'), 'true');
  assert.equal(failure(), undefined, 'a look again that worked clears the failure');
  fx.status = async () => ({});
  await click(again);
  await flush();
  assert.ok([...container.querySelectorAll('.cu-onboarding-rows li')].every((r) => r.getAttribute('data-granted') === 'false'));
});

test("permission card: busy while a request runs; follows main's changes and stops listening when it goes", async () => {
  let listener: (() => void) | null = null;
  let unsubscribed = 0;
  fx.onChanged = (fn: () => void) => {
    listener = fn;
    return () => {
      unsubscribed++;
    };
  };
  let n = 0;
  fx.status = async () => ({ permissions: { screenRecording: ++n > 1, accessibility: true } });
  let finish!: () => void;
  fx.requestPermission = () =>
    new Promise<void>((r) => {
      finish = r;
    });
  await render(createElement(ComputerPermissionCard, { threadId: 't1', permission: 'screenRecording' }));
  await flush();
  const row = () => [...container.querySelectorAll('.cu-onboarding-rows li')][1];
  assert.equal(row().getAttribute('data-granted'), 'false');
  await click(row().querySelector('button'));
  assert.equal((row().querySelector('button') as HTMLButtonElement).disabled, true);
  assert.equal((button(/^Try again/) as HTMLButtonElement).disabled, true);
  finish();
  await flush();
  assert.equal((button(/^Try again/) as HTMLButtonElement).disabled, false);
  // main says something changed: the card looks again
  const before = fx.calls.filter((c: any[]) => c[0] === 'status').length;
  await act(async () => {
    listener!();
  });
  await flush();
  assert.equal(fx.calls.filter((c: any[]) => c[0] === 'status').length, before + 1);
  assert.equal([...container.querySelectorAll('.cu-onboarding-rows li')][0].getAttribute('data-granted'), 'true');
  // a status that answers after the card went away is dropped
  let late!: (v: any) => void;
  fx.status = () =>
    new Promise((r) => {
      late = r;
    });
  await act(async () => {
    listener!();
  });
  await act(async () => root.unmount());
  root = null;
  assert.equal(unsubscribed, 1);
  late({ permissions: {} });
  await flush();
});

test('permission card: Request or Try again that leaves the permission missing says so and what to do next, never nothing', async () => {
  // macOS keeps a stale grant for an older helper build: no prompt shows and the permission stays off
  fx.status = async () => ({ permissions: { accessibility: true, screenRecording: false } });
  fx.requestPermission = async () => false;
  fx.recheck = async () => false;
  await render(createElement(ComputerPermissionCard, { threadId: 't1', permission: 'screenRecording' }));
  await flush();
  const hint = () => container.querySelector('.cu-permission-still');
  assert.equal(hint(), null, 'nothing to explain before the user acts');
  const request = () => [...container.querySelectorAll('.cu-onboarding-rows li')][1].querySelector('button')!;
  assert.equal(request().textContent, 'Request');
  await click(request());
  await flush();
  assert.deepEqual(
    fx.calls.slice(1).map((c: any[]) => c.slice(0, 2)),
    [['requestPermission', 'screenRecording'], ['recheck', 't1'], ['status']],
  );
  assert.equal(hint()!.textContent, 'computerUse.permissionStillOff[Screen Recording]', 'Request that changed nothing says so');
  assert.equal(hint()!.getAttribute('role'), 'status');
  assert.equal(container.querySelector('.cu-permission .config-warning'), null, 'not a failure');
  // Try again while it runs: the old answer goes; when it is still off, the hint comes back
  let finish!: (v: boolean) => void;
  fx.recheck = () =>
    new Promise<boolean>((r) => {
      finish = r;
    });
  await click(button(/^Try again/));
  assert.equal(hint(), null, 'the hint goes while Try again looks again');
  await act(async () => finish(false));
  await flush();
  assert.equal(hint()!.textContent, 'computerUse.permissionStillOff[Screen Recording]', 'Try again that changed nothing says so');
  // a look again that finds nothing missing (main takes the card down) shows no hint
  fx.recheck = async () => true;
  await click(button(/^Try again/));
  await flush();
  assert.equal(hint(), null);
  // a hint for one permission never shows on the card main raised for another
  fx.recheck = async () => false;
  await click(button(/^Try again/));
  await flush();
  assert.ok(hint());
  await act(async () => root.render(createElement(ComputerPermissionCard, { threadId: 't1', permission: 'accessibility' })));
  await flush();
  assert.equal(hint(), null);
  // nor for the same permission when main raises it again later, before the user acts on it
  await act(async () => root.render(createElement(ComputerPermissionCard, { threadId: 't1', permission: 'screenRecording' })));
  await flush();
  assert.equal(hint(), null);
  // main could not read the permissions (its look again answers false): an unread permission is not called off
  fx.status = async () => ({});
  await click(button(/^Try again/));
  await flush();
  assert.equal(hint(), null);
  // the newest status reads it on: no hint, whatever the look again answered
  fx.status = async () => ({ permissions: { accessibility: true, screenRecording: true } });
  await click(button(/^Try again/));
  await flush();
  assert.equal(hint(), null);
  // macOS answered the request off though main's look again found nothing missing: still off while the status says so
  fx.status = async () => ({ permissions: { accessibility: true, screenRecording: false } });
  fx.recheck = async () => true;
  await click(request());
  await flush();
  assert.equal(hint()!.textContent, 'computerUse.permissionStillOff[Screen Recording]');
  // a look again that failed says that, not "still off"
  fx.recheck = async () => {
    throw new Error('helper gone');
  };
  await click(button(/^Try again/));
  await flush();
  assert.equal(hint(), null);
  assert.equal(container.querySelector('.cu-permission .config-warning')!.textContent, "Couldn't check the permissions: helper gone");
});

test('permission card: a status that fails on open leaves the rows unchecked', async () => {
  fx.status = async () => {
    throw new Error('helper not running');
  };
  await render(createElement(ComputerPermissionCard, { threadId: 't1', permission: 'screenRecording' }));
  await flush();
  assert.ok([...container.querySelectorAll('.cu-onboarding-rows li')].every((r) => r.getAttribute('data-granted') === 'false'));
});

/* -- the dev server card (browser_preview_start) ---------------------------- */
test('dev server card: names the requesting agent after the chat changes, the command on its own line with the folder on hover; Allow covers this chat (Enter, 1 or a click), Esc denies; other keys pass', async () => {
  fx.approvals = [
    card({ kind: 'devServer', harness: 'codex', command: 'npm run dev', cwd: '/p/web', tool: 'browser_preview_start' }, 'sage-9'),
  ];
  await render(createElement(Approvals, { threadId: 't1', cwd: '/p' }));
  assert.equal(container.querySelector('.approval-card')!.getAttribute('data-kind'), 'devServer');
  assert.equal(container.querySelector('.approval-kind')!.textContent, 'Dev server');
  assert.equal(container.querySelector('.approval-message')!.textContent, 'Allow Codex to start a dev server?');
  const cmd = container.querySelector('p.sage-access-hint')!;
  assert.deepEqual([cmd.querySelector('code')!.textContent, cmd.getAttribute('title')], ['npm run dev', '/p/web']);
  assert.equal(container.textContent!.includes("can't be undone"), false);
  assert.deepEqual(
    [...container.querySelectorAll('button')].map((b) => b.textContent),
    ['Deny Esc', 'Allow in this chat ⏎'],
  );
  // keys that are not the card's, and input that isn't a person's
  const input = document.createElement('input');
  document.body.append(input);
  await key('Enter', { target: input });
  input.remove();
  const layer = document.createElement('div');
  layer.className = 'popover-layer';
  document.body.append(layer);
  await key('Enter');
  layer.remove();
  await key('x');
  await click(button(/^Allow in this chat/)!, false);
  assert.deepEqual(answers(), []);
  await key('Enter');
  await key('1');
  await click(button(/^Allow in this chat/)!);
  assert.deepEqual(answers(), [
    ['sage-9', { decision: 'allow', scope: 'chat' }],
    ['sage-9', { decision: 'allow', scope: 'chat' }],
    ['sage-9', { decision: 'allow', scope: 'chat' }],
  ]);
  await key('Escape');
  await click(button(/^Deny/));
  assert.deepEqual(answers().slice(3), [
    ['sage-9', { decision: 'deny' }],
    ['sage-9', { decision: 'deny' }],
  ]);
});

test('terminal card: opening a tab shows the folder, and Allow covers this chat', async () => {
  fx.approvals = [card({ kind: 'terminalTab', harness: 'claude', cwd: '/p/web', tool: 'open_terminal_tab' }, 'sage-10')];
  await render(createElement(Approvals, { threadId: 't1', cwd: '/p' }));
  assert.equal(container.querySelector('.approval-message')!.textContent, 'Allow Claude Code to open a terminal?');
  assert.equal(container.querySelector('p.sage-access-hint code')!.textContent, '/p/web');
  assert.ok(button(/^Allow in this chat/));
});

test('terminal card: running a command shows the exact line and allows it once', async () => {
  fx.approvals = [card({ kind: 'terminalTab', harness: 'claude', cwd: '/p/web', command: 'npm test', tool: 'run_in_terminal' }, 'sage-11')];
  await render(createElement(Approvals, { threadId: 't1', cwd: '/p' }));
  assert.equal(container.querySelector('.approval-message')!.textContent, 'Allow Claude Code to run this in a terminal?');
  assert.equal(container.querySelector('p.sage-access-hint code')!.textContent, 'npm test');
  assert.equal(container.querySelector('p.sage-access-hint')!.getAttribute('title'), '/p/web');
  assert.equal(button(/^Allow in this chat/), undefined);
  await click(button(/^Allow once/)!);
  assert.deepEqual(answers().at(-1), ['sage-11', { decision: 'allow', scope: 'chat' }]);
});

/* -- the browser permission card (a page the user drives asks for the camera, location...) -- */
test('browser permission card: names the site and what it wants; Allow once (Enter, 1), Always (2), Esc denies; other keys pass', async () => {
  fx.approvals = [
    card({ kind: 'browserPermission', harness: 'claude', origin: 'https://meet.test', permissions: ['camera', 'microphone'] }, 'sage-7'),
  ];
  await render(createElement(Approvals, { threadId: 't1', cwd: '/p' }));
  assert.equal(container.querySelector('.approval-card')!.getAttribute('data-kind'), 'browserPermission');
  assert.equal(container.querySelector('.approval-kind')!.textContent, 'Browser');
  assert.equal(container.querySelector('.approval-message')!.textContent, 'Allow https://meet.test to use your camera and microphone?');
  assert.deepEqual(
    [...container.querySelectorAll('button')].map((b) => b.textContent),
    ['Deny Esc', 'Allow once ⏎', ''],
  );
  const input = document.createElement('input');
  document.body.append(input);
  await key('Enter', { target: input });
  input.remove();
  const layer = document.createElement('div');
  layer.className = 'popover-layer';
  document.body.append(layer);
  await key('1');
  layer.remove();
  await key('x');
  await key('3');
  await click(button(/^Allow once/), false);
  assert.deepEqual(answers(), []);
  await key('Enter');
  await key('1');
  await key('2');
  await click(button(/^Allow once/));
  await click(container.querySelector('.approval-foot .chevron')!);
  await click(button(/^Always allow for this site/)!);
  await key('Escape');
  await click(button(/^Deny/));
  assert.deepEqual(answers(), [
    ['sage-7', { decision: 'allow', scope: 'once' }],
    ['sage-7', { decision: 'allow', scope: 'once' }],
    ['sage-7', { decision: 'allow', scope: 'always' }],
    ['sage-7', { decision: 'allow', scope: 'once' }],
    ['sage-7', { decision: 'allow', scope: 'always' }],
    ['sage-7', { decision: 'deny' }],
    ['sage-7', { decision: 'deny' }],
  ]);
});

test('browser permission card: a request with no permissions listed still renders', async () => {
  fx.approvals = [card({ kind: 'browserPermission', harness: 'codex', origin: 'https://a.test' }, 'sage-8')];
  await render(createElement(Approvals, { threadId: 't1', cwd: '/p' }));
  assert.equal(container.querySelector('.approval-message')!.textContent, 'Allow https://a.test to use your ?');
});

test('takeover card: the one-line reason shows under the sentence; with no apps it names none', async () => {
  fx.approvals = [card({ kind: 'computerTakeover', harness: 'claude', apps: [], reason: 'Needs the real pointer.' })];
  await render(createElement(Approvals, { threadId: 't1', cwd: '/p' }));
  assert.equal(container.querySelector('.approval-message')!.textContent, 'Allow Claude Code to use your mouse and keyboard?');
  assert.equal(container.querySelector('.desktop-access-why')!.textContent, 'Needs the real pointer.');
  assert.equal(container.querySelector('.desktop-access-warning'), null);
});

for (const outcome of ['success', 'failure'] as const) {
  test(`permission card: an older status ${outcome} cannot undo a newer change`, async () => {
    let listener!: () => void;
    fx.onChanged = (fn: () => void) => {
      listener = fn;
      return () => {};
    };
    await render(createElement(ComputerPermissionCard, { threadId: 't1', permission: 'screenRecording' }));
    await flush();
    const accessibility = () => container.querySelector('li')!.getAttribute('data-granted');
    assert.equal(accessibility(), 'false');
    const reads = controlledReads<{ permissions: { accessibility?: boolean } }>();
    fx.status = reads.read;
    await click(button(/^Try again/));
    await flush();
    await act(async () => {
      listener();
    });
    assert.equal(reads.requests.length, 2);
    await act(async () => reads.requests[1].resolve({ permissions: { accessibility: true } }));
    await flush();
    assert.equal(accessibility(), 'true');
    await act(async () => {
      if (outcome === 'failure') reads.requests[0].reject(new Error('obsolete read'));
      else reads.requests[0].resolve({ permissions: {} });
    });
    await flush();
    assert.equal(accessibility(), 'true');
    assert.equal(container.querySelectorAll('.config-warning').length, 0, 'an obsolete rejection is not current failure');
    assert.equal((button(/^Try again/) as HTMLButtonElement).disabled, false);
  });
}

for (const retirement of ['chat', 'permission', 'unmount'] as const) {
  for (const boundary of ['request', 'recheck', 'status'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      test(`permission card retires ${boundary} ${outcome} after ${retirement}`, async () => {
        const request = deferred<any>();
        const pending = () => request.promise;
        fx.status = async () => ({ permissions: { accessibility: true, screenRecording: false } });
        await render(createElement(ComputerPermissionCard, { threadId: 'old', permission: 'screenRecording' }));
        await flush();
        if (boundary === 'request') fx.requestPermission = pending;
        if (boundary === 'recheck') fx.recheck = pending;
        if (boundary === 'status') fx.status = pending;
        await click(boundary === 'request' ? button(/^Request$/) : button(/^Try again/));
        await flush();
        fx.status = async () => ({ permissions: { accessibility: false, screenRecording: false } });
        fx.recheck = async () => true;
        if (retirement === 'unmount') {
          await act(async () => root.unmount());
          root = null;
        } else {
          await act(async () =>
            root.render(
              createElement(ComputerPermissionCard, {
                threadId: retirement === 'chat' ? 'new' : 'old',
                permission: retirement === 'permission' ? 'accessibility' : 'screenRecording',
              }),
            ),
          );
        }
        await flush();
        const replacement = deferred<boolean>();
        if (retirement !== 'unmount') {
          assert.equal((button(/^Try again/) as HTMLButtonElement).disabled, false, 'replacement controls are fresh');
          fx.recheck = () => replacement.promise;
          await click(button(/^Try again/));
        }
        fx.calls = [];
        await act(async () =>
          outcome === 'failure'
            ? request.reject(new Error('obsolete'))
            : request.resolve(boundary === 'status' ? { permissions: { accessibility: true } } : false),
        );
        await flush();
        assert.deepEqual(fx.calls, [], 'retired actions start no recheck or helper read');
        assert.equal(container.querySelectorAll('.config-warning, .cu-permission-still').length, 0);
        if (retirement !== 'unmount') {
          assert.equal(container.querySelector('li')!.getAttribute('data-granted'), 'false');
          assert.equal((button(/^Try again/) as HTMLButtonElement).disabled, true, 'obsolete finally cannot clear the replacement action');
          await act(async () => replacement.resolve(true));
          await flush();
          assert.equal((button(/^Try again/) as HTMLButtonElement).disabled, false);
        }
      });
    }
  }
}

test('permission card ignores queued notifications after disposal', async () => {
  let queued!: () => void;
  fx.onChanged = (listener: () => void) => {
    queued = listener;
    return () => {};
  };
  await render(createElement(ComputerPermissionCard, { threadId: 't1', permission: 'screenRecording' }));
  await act(async () => root.unmount());
  root = null;
  fx.calls = [];
  await act(async () => queued());
  await flush();
  assert.deepEqual(fx.calls, []);
});
