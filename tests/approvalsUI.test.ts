// The approval stack (src/components/thread/Approvals.tsx): MoPilot's own cards (computerAccessSet,
// computerTakeover, computerConfirm, browserOrigin) answer main's broker with the card's id on a person's
// click or key, and Stop stays reachable while a card hides the composer. Rendered for real with
// happy-dom; the rest of the component's imports are stubbed.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import * as react from 'react';
import { iconStubs, mockSource, popoverStubs, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const fixture: any = {
  state: { runtime: {}, segments: {} },
  approvals: [] as any[],
  calls: [] as any[],
  listeners: new Set<Function>(),
  subscribe(fn: Function) {
    fixture.listeners.add(fn);
    return () => fixture.listeners.delete(fn);
  },
  update(patch: any) {
    fixture.state = { ...fixture.state, ...patch };
    for (const fn of fixture.listeners) fn();
  },
};

const f = fixture;
const nul = () => null;
const record = (names: string) =>
  Object.fromEntries(
    names.split(',').map((n) => [
      n.trim(),
      (...a: any[]) => {
        f.calls.push([n.trim(), ...a]);
      },
    ]),
  );
stubStore({
  useStore: Object.assign((s: any) => s(react.useSyncExternalStore(f.subscribe, () => f.state)), { getState: () => f.state }),
  chatHarnessLabel: () => 'Claude Code',
  chatOf: (id: string) => id,
  ...record('resolveRequest,toast'),
  sendOrDraft: async (...a: any[]) => void f.calls.push(['sendOrDraft', ...a]),
  toastFailure: () => () => {},
  interrupt: async (id: string) => {
    f.calls.push(['interrupt', id]);
  },
});
mockSource('src/lib/format.ts', { prettyCommand: (c: any) => c });
mockSource('src/lib/paths.ts', { relPath: (p: any) => p });
mockSource('src/session/open.ts', { openLink: (u: string) => void f.calls.push(['openLink', u]) });
mockSource('src/components/diff/DiffView.tsx', { InlineDiff: nul, fileChangeToDiff: nul });
mockSource('src/components/ui/Popover.tsx', popoverStubs());
installNativeStub({
  computer: {
    answer: async (id: string, r: any) => {
      f.calls.push(['answer', id, r]);
      if (f.answerError !== undefined) throw f.answerError;
      return true;
    },
  },
});
mockSource('src/components/ui/icons.tsx', iconStubs());
mockSource('src/harness/acpTranslate.ts', { permissionChoices: () => [], toolItem: nul });
mockSource('src/store/session/useSession.ts', {
  useSession: () => ({ approvals: react.useSyncExternalStore(f.subscribe, () => f.approvals) }),
  useSessionField: (id: any, pick: any) =>
    pick(((() => ({ approvals: react.useSyncExternalStore(f.subscribe, () => f.approvals) })) as (id: any) => any)(id)),
});
mockSource('src/harness/approvalRequests.ts', { requestsOf: () => [] });
mockSource('src/harness/elicitation.ts', {
  elicitationAnswer: nul,
  nativeAppAnswer: nul,
  nativeAppApproval: nul,
  browserUseApproval: nul,
  browserUseAnswer: nul,
  allowsAllSites: () => false,
});
mockSource('src/harness/chromeApproval.ts', { chromeApproval: nul, chromeSuggestion: nul, chromeTabUrl: nul, chromeTool: nul });
mockSource('src/harness/adapters/codexApi.ts', { codexApi: { configRequirementsRead: async () => null } });
mockSource('src/session/harness/acp.ts', { acpLabelOf: () => 'ACP' });
mockSource('src/harness/copy.ts', { copy: () => 'copy' });
mockSource('src/lib/focus.ts', { isEnter: (e: any) => e.key === 'Enter' });
mockSource('src/components/thread/QuestionCard.tsx', { QuestionCard: nul });
mockSource('src/components/thread/approvals/autoSwitch.tsx', { AutoSwitchItem: nul });
const { act, createElement } = react;
const { createRoot } = await import('react-dom/client');
const { Approvals } = await import('../src/components/thread/Approvals.tsx');

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement;
async function render(approvals: any[], running = true) {
  fixture.approvals = approvals;
  fixture.calls = [];
  fixture.state = { runtime: running ? { chat1: { activeTurnId: 'turn-1' } } : {}, segments: {} };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(Approvals, { threadId: 'chat1', cwd: '/w' })));
  return container;
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
});

/** A person's input is trusted; a script's is not (happy-dom leaves isTrusted unset, so tests set it). */
const trusted = <E extends Event>(e: E, isTrusted = true) => (Object.defineProperty(e, 'isTrusted', { value: isTrusted }), e);
const button = (text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text)) as HTMLButtonElement | undefined;
const click = async (el: Element, isTrusted = true) =>
  act(async () => {
    el.dispatchEvent(trusted(new window.MouseEvent('click', { bubbles: true, cancelable: true }) as any, isTrusted));
  });
const key = async (k: string, target: EventTarget = window as any, init: any = {}) =>
  act(async () => {
    target.dispatchEvent(trusted(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }) as any));
  });
const answers = () => fixture.calls.filter((c: any[]) => c[0] === 'answer').map((c: any[]) => c.slice(1));

const card = (id: string, params: any) => ({ id, method: `sage/${params.kind}`, params });
const accessSet = card('sage-computerAccessSet-3', {
  kind: 'computerAccessSet',
  harness: 'claude',
  reason: 'edit a note',
  apps: [{ bundleId: 'com.apple.TextEdit', name: 'TextEdit', tier: 'full', tierLabel: 'Full control' }],
  denied: [],
  clipboardRead: false,
  clipboardWrite: false,
  systemKeyCombos: false,
});

test('desktop access card: Deny and Allow answer the broker with the card id', async () => {
  await render([accessSet]);
  assert.match(container.textContent!, /Allow Claude Code to use TextEdit\?/);
  await click(button('Deny')!);
  assert.deepEqual(answers(), [['sage-computerAccessSet-3', { decision: 'deny' }]]);
  fixture.calls = [];
  await click(button('Allow')!);
  assert.deepEqual(answers(), [
    [
      'sage-computerAccessSet-3',
      { decision: 'allow', apps: ['com.apple.TextEdit'], clipboardRead: false, clipboardWrite: false, systemKeyCombos: false },
    ],
  ]);
});

test('desktop access card: Esc denies and Enter allows; script clicks and keys do nothing', async () => {
  await render([accessSet]);
  await click(button('Deny')!, false);
  await act(async () => {
    window.dispatchEvent(trusted(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }) as any, false));
  });
  assert.deepEqual(answers(), []);
  await key('Escape');
  assert.deepEqual(answers(), [['sage-computerAccessSet-3', { decision: 'deny' }]]);
  fixture.calls = [];
  await key('Enter');
  assert.equal(answers()[0][1].decision, 'allow');
});

test('desktop access card: unchecking every app leaves Allow disabled', async () => {
  await render([accessSet]);
  const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
  await click(box);
  assert.equal(box.checked, false);
  assert.equal(button('Allow')!.disabled, true);
  await key('Enter');
  assert.deepEqual(answers(), []);
});

test('takeover card: Allow and Deny answer with the card id', async () => {
  const takeover = card('sage-computerTakeover-4', {
    kind: 'computerTakeover',
    harness: 'claude',
    apps: [{ bundleId: 'com.apple.TextEdit', name: 'TextEdit', tier: 'full' }],
  });
  await render([takeover]);
  assert.match(container.textContent!, /Allow Claude Code to use your mouse and keyboard in TextEdit\?/);
  await click(button('Allow')!);
  await click(button('Deny')!);
  assert.deepEqual(answers(), [
    ['sage-computerTakeover-4', { decision: 'allow' }],
    ['sage-computerTakeover-4', { decision: 'deny' }],
  ]);
});

test('confirm and site cards: Deny, Esc and Allow answer with the card id', async () => {
  const confirm = card('sage-computerConfirm-5', {
    kind: 'computerConfirm',
    harness: 'claude',
    app: { bundleId: 'com.apple.mail', name: 'Mail' },
    verb: 'send',
    summary: 'an email',
  });
  await render([confirm]);
  assert.match(container.textContent!, /This can't be undone/);
  await click(button('Deny')!);
  await click(button('Allow once')!);
  await key('Escape');
  assert.deepEqual(answers(), [
    ['sage-computerConfirm-5', { decision: 'deny' }],
    ['sage-computerConfirm-5', { decision: 'allow', scope: 'once' }],
    ['sage-computerConfirm-5', { decision: 'deny' }],
  ]);
  await act(async () => root!.unmount());
  root = null;
  container.remove();

  const site = card('sage-browserOrigin-6', {
    kind: 'browserOrigin',
    harness: 'claude',
    origin: 'https://a.test',
    level: 'read',
    levels: [
      { id: 'read', label: 'Read only' },
      { id: 'write', label: 'Read and write' },
    ],
  });
  await render([site]);
  assert.match(container.textContent!, /Allow Claude Code to use https:\/\/a\.test\?/);
  await click(button('Deny')!);
  await click(container.querySelector('.approval-foot .chevron')!);
  await click(button('Allow in this chat')!);
  await key('Escape');
  assert.deepEqual(answers(), [
    ['sage-browserOrigin-6', { decision: 'deny' }],
    ['sage-browserOrigin-6', { decision: 'allow', scope: 'chat', level: 'read' }],
    ['sage-browserOrigin-6', { decision: 'deny' }],
  ]);
});

test("site and action cards name their browser: the in-app browser, or the user's Chrome where they are signed in", async () => {
  const levels = [
    { id: 'read', label: 'Read only' },
    { id: 'write', label: 'Read and write' },
  ];
  await render([
    card('sage-browserOrigin-7', {
      kind: 'browserOrigin',
      harness: 'claude',
      browser: 'chrome',
      origin: 'https://b.test',
      level: 'read',
      levels,
    }),
  ]);
  assert.match(container.textContent!, /Allow Claude Code to use https:\/\/b\.test in your Chrome\?Read only/);
  assert.equal(container.querySelector('.approval-explain'), null);
  await act(async () => root!.unmount());
  root = null;
  container.remove();
  await render([
    card('sage-browserOrigin-8', {
      kind: 'browserOrigin',
      harness: 'claude',
      browser: 'iab',
      origin: 'https://c.test',
      level: 'read',
      levels,
    }),
  ]);
  assert.match(container.textContent!, /Allow Claude Code to use https:\/\/c\.test in the built-in browser\?/);
  await act(async () => root!.unmount());
  root = null;
  container.remove();
  await render([
    card('sage-computerConfirm-9', {
      kind: 'computerConfirm',
      harness: 'claude',
      browser: 'chrome',
      app: { bundleId: 'https://mail.test', name: 'https://mail.test' },
      verb: 'send a message',
      summary: 'click "Send"',
    }),
  ]);
  assert.equal(
    container.querySelector('.approval-message')!.textContent,
    "Allow Claude Code to send a message in https://mail.test? This can't be undone.",
  );
  assert.equal(container.querySelector('.sage-access-hint')!.textContent, 'click "Send" · in your Chrome, signed in');
  // where alone, with no summary, is still said under the question
  await act(async () => root!.unmount());
  root = null;
  container.remove();
  await render([card('sage-computerConfirm-10', { kind: 'computerConfirm', harness: 'claude', browser: 'iab', verb: 'click' })]);
  assert.equal(container.querySelector('.sage-access-hint')!.textContent, 'in the built-in browser');
  // neither a summary nor a place: no line under the question
  await act(async () => root!.unmount());
  root = null;
  container.remove();
  await render([card('sage-computerConfirm-11', { kind: 'computerConfirm', harness: 'claude', verb: 'click' })]);
  assert.equal(container.querySelector('.approval-message')!.textContent, "Allow Claude Code to click in this app? This can't be undone.");
  assert.equal(container.querySelector('.sage-access-hint'), null);
});

test('an answer main cannot take is reported, not dropped: the card stays and says why', async () => {
  for (const [error, text] of [
    [new Error('broker gone'), "Couldn't send your answer: broker gone"],
    ['closed', "Couldn't send your answer: closed"],
  ] as const) {
    fixture.answerError = error;
    try {
      await render([accessSet]);
      await click(button('Deny')!);
      assert.deepEqual(answers(), [['sage-computerAccessSet-3', { decision: 'deny' }]]);
      assert.deepEqual(
        fixture.calls.filter((c: any[]) => c[0] === 'toast'),
        [['toast', text, 'error']],
      );
      assert.ok(button('Deny'), 'the card is still there to answer again');
    } finally {
      fixture.answerError = undefined;
      await act(async () => root!.unmount());
      root = null;
      container.remove();
    }
  }
});

test('Stop stays reachable under a card while the turn runs, with the queue count', async () => {
  const takeover = card('sage-computerTakeover-7', { kind: 'computerTakeover', harness: 'claude', apps: [] });
  await render([accessSet, takeover]);
  assert.match(container.querySelector('.approval-queue')!.textContent!, /1 more waiting/);
  await click(button('Stop chat')!);
  assert.deepEqual(
    fixture.calls.filter((c: any[]) => c[0] === 'interrupt'),
    [['interrupt', 'chat1']],
  );
  assert.deepEqual(answers(), []);
});

test('no Stop when the turn is not running, and nothing at all without a card', async () => {
  await render([accessSet], false);
  assert.equal(button('Stop chat') === undefined, true);
  assert.equal(container.querySelector('.approval-queue') === null, true);
  await act(async () => root!.unmount());
  root = null;
  container.remove();
  await render([], true);
  assert.equal(container.innerHTML, '');
});

test('an ordinary action on a high-risk site: Allow for this task, or once, with a click or a key and no hold (#2328)', async () => {
  const task = card('sage-computerConfirm-9', {
    kind: 'computerConfirm',
    harness: 'claude',
    browser: 'chrome',
    app: { bundleId: 'https://www.travel.americanexpress.com', name: 'https://www.travel.americanexpress.com' },
    verb: 'act on a high-risk site',
    summary: 'computer: left_click',
    task: true,
    risk: { level: 'high', category: 'banking', label: 'Banking site', explanation: "The agent won't pay, transfer or trade." },
  });
  await render([task]);
  assert.match(container.textContent!, /Allow Claude Code to act on https:\/\/www\.travel\.americanexpress\.com\?/);
  assert.doesNotMatch(container.textContent!, /can't be undone/);
  await click(button('Allow for this task')!);
  // the menu's Allow once
  await click(container.querySelector('[aria-label="Approval options"]')!);
  await click(button('Allow once')!);
  await key('2');
  // two choices: 3 picks nothing
  await key('3');
  await key('1');
  await key('Enter', window as any, { metaKey: true });
  await key('Enter', window as any, { metaKey: true, shiftKey: true });
  assert.deepEqual(answers(), [
    ['sage-computerConfirm-9', { decision: 'allow', scope: 'task' }],
    ['sage-computerConfirm-9', { decision: 'allow', scope: 'once' }],
    ['sage-computerConfirm-9', { decision: 'allow', scope: 'task' }],
    ['sage-computerConfirm-9', { decision: 'allow', scope: 'once' }],
    ['sage-computerConfirm-9', { decision: 'allow', scope: 'once', level: undefined }],
  ]);
});

test('an ordinary message: Allow messages for this errand, or once, with no hold; a committing one says why and keeps the hold', async () => {
  const errand = card('sage-computerConfirm-11', {
    kind: 'computerConfirm',
    harness: 'codex',
    browser: 'iab',
    app: { bundleId: 'https://help.store.example', name: 'https://help.store.example' },
    verb: 'send a message',
    summary: 'click Send',
    errand: true,
  });
  await render([errand]);
  assert.match(container.textContent!, /Allow Codex to send a message in https:\/\/help\.store\.example\? This can't be undone\./);
  await click(button('Allow messages for this errand')!);
  await click(container.querySelector('[aria-label="Approval options"]')!);
  await click(button('Allow once')!);
  await key('2');
  await key('1');
  assert.deepEqual(answers(), [
    ['sage-computerConfirm-11', { decision: 'allow', scope: 'errand' }],
    ['sage-computerConfirm-11', { decision: 'allow', scope: 'once' }],
    ['sage-computerConfirm-11', { decision: 'allow', scope: 'errand' }],
    ['sage-computerConfirm-11', { decision: 'allow', scope: 'once' }],
  ]);
  await act(async () => root!.unmount());
  const commits = card('sage-computerConfirm-12', {
    kind: 'computerConfirm',
    harness: 'codex',
    app: { bundleId: 'https://help.store.example', name: 'https://help.store.example' },
    verb: 'send a message',
    commits: 'it may accept or decline an offer',
  });
  await render([commits]);
  assert.match(container.textContent!, /Asks every time: it may accept or decline an offer\./);
  assert.equal(button('Allow messages for this errand'), undefined);
  assert.ok(container.textContent!.includes('hold ⌘⏎'), 'Allow once is held, as for any irreversible step');
});

test('queued cards show as ghosts behind the shown one: none for a lone card, then one per waiting card up to two', async () => {
  const takeover = card('sage-computerTakeover-7', { kind: 'computerTakeover', harness: 'claude', apps: [] });
  const takeover2 = card('sage-computerTakeover-8', { kind: 'computerTakeover', harness: 'claude', apps: [] });
  const takeover3 = card('sage-computerTakeover-9', { kind: 'computerTakeover', harness: 'claude', apps: [] });
  const ghosts = () => [...container.querySelectorAll<HTMLElement>('.approval-ghost')].map((g) => g.style.getPropertyValue('--n'));
  await render([accessSet]);
  assert.deepEqual(ghosts(), []);
  await render([accessSet, takeover]);
  assert.deepEqual(ghosts(), ['1']);
  await render([accessSet, takeover, takeover2, takeover3]);
  assert.deepEqual(ghosts(), ['1', '2']);
  assert.equal(container.querySelector('.approval-ghosts')!.getAttribute('aria-hidden'), 'true');
});

test('#3840: a confirmation shows the pending destination separately from quoted page text', async () => {
  const actionTarget = {
    url: 'https://acme.com@evil.test/notes?' + 'q'.repeat(400),
    page: 'https://crm.test/deals/DEAL-5',
    label: 'https://evil.test/notes?…',
  };
  await render([
    card('sage-computerConfirm-target', {
      kind: 'computerConfirm',
      harness: 'codex',
      verb: 'submit a form',
      summary: 'Quoted text names /contacts/evil/delete',
      actionTarget,
    }),
  ]);
  const target = container.querySelector('[data-action-target]')!;
  assert.equal(target.textContent, `To: ${actionTarget.label}`);
  assert.deepEqual(JSON.parse(target.getAttribute('data-action-target')!), actionTarget);
  assert.doesNotMatch(target.textContent!, /acme.com@/);
});

test('an ordinary action on a high-risk site may be allowed for good: Always allow on this site with a click or ⇧⌘↩, Allow once still held (#5464)', async () => {
  const params = {
    kind: 'computerConfirm',
    harness: 'claude',
    browser: 'iab',
    app: { bundleId: 'https://www.americanexpress.com', name: 'https://www.americanexpress.com' },
    verb: 'act on a high-risk site',
    summary: 'JavaScript: document.title',
    tool: 'JavaScript',
    siteAlways: true,
    risk: { level: 'high', category: 'banking', label: 'Banking site', explanation: "The agent won't pay, transfer or trade." },
  };
  await render([card('sage-computerConfirm-20', params)]);
  await click(button('Always allow on this site')!);
  await key('Enter', window as any, { metaKey: true, shiftKey: true });
  // a focused control keeps its own Enter: the chord does nothing there
  await key('Enter', container.querySelector('.ap-btn.deny')!, { metaKey: true, shiftKey: true });
  // that press started Allow once's hold instead; letting go ends it with no answer
  await act(async () => {
    window.dispatchEvent(trusted(new window.KeyboardEvent('keyup', { key: 'Meta', bubbles: true }) as any));
  });
  await click(container.querySelector('[aria-label="Approval options"]')!);
  await click(button('Allow once')!);
  assert.deepEqual(answers(), [
    ['sage-computerConfirm-20', { decision: 'allow', scope: 'always' }],
    ['sage-computerConfirm-20', { decision: 'allow', scope: 'always' }],
    ['sage-computerConfirm-20', { decision: 'allow', scope: 'once' }],
  ]);
  await act(async () => root!.unmount());
  root = null;
  container.remove();
  // the task card lists it in its menu
  await render([card('sage-computerConfirm-21', { ...params, task: true })]);
  await click(container.querySelector('[aria-label="Approval options"]')!);
  await click(button('Always allow on this site')!);
  assert.deepEqual(answers().at(-1), ['sage-computerConfirm-21', { decision: 'allow', scope: 'always' }]);
  await act(async () => root!.unmount());
  root = null;
  container.remove();
  // a paired computer's card never offers it: Allow once, held
  await render([card('sage-computerConfirm-22', { ...params, remote: { host: 'h', hostName: 'Mini' } })]);
  assert.equal(button('Always allow on this site'), undefined);
  await key('Enter', window as any, { metaKey: true, shiftKey: true });
  assert.equal(
    answers().some(([id]: any) => id === 'sage-computerConfirm-22'),
    false,
  );
});
