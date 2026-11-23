// MoMo's approval card in the renderer (#2139, src/components/momo/MomoActionCard.tsx and src/lib/momoActionCopy.ts), rendered in happy-dom through the chat's approval stack (Approvals.tsx): the question, why, the exact detail, Allow once and each scope the rule allows, Deny and Always deny, Enter / 1–3 / Esc, and only a person's input answering. native.computer (IPC) and the store are mocked.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import * as react from 'react';
import { iconStubs, mockSource, popoverStubs, taggedIcon, withStoreSlices } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const fx: any = { calls: [] as any[], approvals: [] as any[] };
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
  'harness/copy.ts': { copy: () => '' },
  'components/ui/icons.tsx': iconStubs(taggedIcon),
  'lib/format.ts': { prettyCommand: (x: any) => String(x) },
  'lib/paths.ts': { relPath: (x: any) => x },
  'session/open.ts': { openLink: nul },
  'components/diff/DiffView.tsx': { InlineDiff: nul, fileChangeToDiff: nul },
  'components/ui/Popover.tsx': popoverStubs(),
  'harness/acpTranslate.ts': { permissionChoices: () => [], toolItem: nul },
  'store/session/useSession.ts': {
    useSession: () => ({ approvals: fx.approvals }),
    useSessionField: (id: any, pick: any) => pick(((() => ({ approvals: fx.approvals })) as (id: any) => any)(id)),
  },
  'harness/approvalRequests.ts': { requestsOf: () => [] },
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
  'components/thread/QuestionCard.tsx': { QuestionCard: nul },
  // the connect card has its own test (momoConnectCardUI.test.ts): here only that Approvals places it
  'components/momo/MomoConnectCard.tsx': {
    MomoConnectCard: (p: any) => react.createElement('div', { 'data-stub': 'connect', 'data-id': p.id, 'data-source': p.source }),
  },
  'components/thread/approvals/autoSwitch.tsx': { AutoSwitchItem: nul },
};
// the bridge the modules read, installed in the native port (src/lib/native.ts)
installNativeStub({ computer: { answer: (...a: any[]) => (fx.calls.push(a), Promise.resolve(true)) } });
for (const [rel, exports] of Object.entries(withStoreSlices(stubs))) mockSource(`src/${rel}`, exports);
const { act, createElement } = react;
const { createRoot } = await import('react-dom/client');
const { Approvals } = await import('../src/components/thread/Approvals.tsx');
const { momoActionTitle, momoActionWhy, destinationText, SCOPE_LABEL, momoActionChoices, reachCount, reachText } = await import(
  '../src/lib/momoActionCopy.ts'
);

let root: any;
let container: HTMLElement;
async function render(momo: any) {
  fx.approvals = [{ id: 'sage-momoAction-1', method: 'sage/momoAction', params: { kind: 'momoAction', harness: 'codex', momo } }];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Approvals, { threadId: 't1', cwd: '/p' })));
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = null;
  container?.remove();
  document.querySelectorAll('.popover-layer').forEach((n) => n.remove());
  fx.calls = [];
  fx.approvals = [];
});

const trusted = <T extends Event>(e: T, value = true) => (Object.defineProperty(e, 'isTrusted', { value }), e);
async function click(label: string, isTrusted = true) {
  const el = [...container.querySelectorAll('button')].find((b) => b.textContent === label);
  assert.ok(el, `no button ${label}`);
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
const answers = () => fx.calls.map((c: any[]) => c[1]);
const buttons = () => [...container.querySelectorAll('button')].map((b) => b.textContent);

const change = {
  action: 'change',
  tool: 'notes_write',
  source: 'Notes',
  account: 'work',
  summary: 'Write “hi” to Notes',
  hosts: [],
  recipients: [],
  recipientItems: [],
  recipientCount: 0,
  blocked: '',
  unknown: false,
  reasons: [],
  scopes: ['once', 'chat', 'today', '30d'],
  denyAlways: true,
};

test('the card: an icon and the question, why, the exact detail, then Muse’s four, with today and Always deny under More options', async () => {
  await render(change);
  const card = container.querySelector('[data-kind="momoAction"]')!;
  assert.ok(card.classList.contains('approval-card'));
  assert.equal(card.getAttribute('aria-label'), 'Allow MoMo to change Notes?');
  assert.equal(card.querySelector('h3')!.textContent, 'Allow MoMo to change Notes?');
  assert.equal(card.querySelector('[data-icon]')!.getAttribute('data-icon'), 'Pencil');
  assert.equal(card.querySelector('p')!.textContent, 'Notes is set to ask before changes.');
  assert.deepEqual(
    [...card.querySelectorAll('dt, dd')].map((n) => n.textContent),
    ['Notes · work', 'Write “hi” to Notes'],
  );
  // the four buttons, then More options' own (in a closed disclosure)
  assert.deepEqual(buttons(), ['Allow once', 'Allow for this chat', 'Always allow', 'Deny', 'Allow today', 'Always deny']);
  const more = card.querySelector('details')!;
  assert.equal(more.querySelector('summary')!.textContent, 'More options');
  assert.equal(more.open, false);
  assert.deepEqual(
    [...more.querySelectorAll('button')].map((b) => b.textContent),
    ['Allow today', 'Always deny'],
  );
  const always = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Always allow')!;
  assert.equal(always.getAttribute('title'), 'For 30 days, in every MoMo chat');
  await click('Allow once');
  await click('Allow for this chat');
  await click('Allow today');
  await click('Always allow');
  await click('Deny');
  await click('Always deny');
  assert.deepEqual(fx.calls[0][0], 'sage-momoAction-1');
  assert.deepEqual(answers(), [
    { decision: 'allow', scope: 'once' },
    { decision: 'allow', scope: 'chat' },
    { decision: 'allow', scope: 'today' },
    { decision: 'allow', scope: '30d' },
    { decision: 'deny' },
    { decision: 'deny', always: true },
  ]);
});

test('only a person’s click answers', async () => {
  await render(change);
  await click('Allow once', false);
  assert.deepEqual(answers(), []);
});

test('keys: Enter allows once, 1–3 pick the allow buttons in order, Esc denies; a field, a menu or a synthetic key keeps them', async () => {
  await render(change);
  await key('Enter');
  await key('2');
  await key('3');
  await key('Escape');
  assert.deepEqual(answers(), [
    { decision: 'allow', scope: 'once' },
    { decision: 'allow', scope: 'chat' },
    { decision: 'allow', scope: '30d' },
    { decision: 'deny' },
  ]);
  fx.calls = [];
  const input = document.createElement('input');
  document.body.append(input);
  await key('Enter', { target: input });
  input.remove();
  const layer = document.createElement('div');
  layer.className = 'popover-layer';
  document.body.append(layer);
  await key('Escape');
  layer.remove();
  await key('Escape', { isTrusted: false });
  await key('x');
  assert.deepEqual(answers(), []);
});

test('a send after a private read: once only, the destinations in the detail, no Always deny', async () => {
  await render({
    ...change,
    action: 'read',
    summary: '',
    account: '',
    hosts: ['example.com'],
    recipients: ['ann@example.com'],
    recipientCount: 1,
    reasons: ['egress'],
    scopes: ['once'],
    denyAlways: false,
  });
  const card = container.querySelector('[data-kind="momoAction"]')!;
  assert.equal(card.querySelector('h3')!.textContent, 'Allow MoMo to send to ann@example.com and 1 more?');
  assert.equal(card.querySelector('[data-icon]')!.getAttribute('data-icon'), 'Send');
  assert.equal(card.querySelector('p')!.textContent, 'This chat read your private data, and this goes somewhere new.');
  assert.deepEqual(
    [...card.querySelectorAll('dt, dd')].map((n) => n.textContent),
    ['Notes', 'notes_write', 'To · 2', 'ann@example.com, example.com'],
  );
  assert.deepEqual(buttons(), ['Allow once', 'Deny']);
  await key('1');
  assert.deepEqual(answers(), [{ decision: 'allow', scope: 'once' }]);
});

test('a read whose destination can’t be told, and a card with no scopes, still offers Allow once', async () => {
  await render({ ...change, action: 'read', unknown: true, reasons: ['unknown-destination'], scopes: [], denyAlways: false });
  const card = container.querySelector('[data-kind="momoAction"]')!;
  assert.equal(card.querySelector('h3')!.textContent, 'Allow MoMo to send data out?');
  assert.equal(card.querySelector('p')!.textContent, "MoMo can't tell where this goes.");
  assert.deepEqual(
    [...card.querySelectorAll('dd')].map((n) => n.textContent),
    ['Write “hi” to Notes', "Somewhere MoMo can't tell"],
  );
  assert.deepEqual(buttons(), ['Allow once', 'Deny']);
  await key('Enter');
  assert.deepEqual(answers(), [{ decision: 'allow', scope: 'once' }]);
});

test('a plain read shows the eye and says the source asks first', async () => {
  await render({ ...change, action: 'read', scopes: ['once'] });
  const card = container.querySelector('[data-kind="momoAction"]')!;
  assert.equal(card.querySelector('h3')!.textContent, 'Allow MoMo to read Notes?');
  assert.equal(card.querySelector('[data-icon]')!.getAttribute('data-icon'), 'Eye');
  assert.equal(card.querySelector('p')!.textContent, 'Notes is set to ask first.');
});

test('the copy: destinations named, the first reason that asks every time, each scope’s label', () => {
  assert.equal(destinationText({ hosts: [], recipients: [], recipientCount: 0 }), null);
  assert.equal(destinationText({ hosts: ['a.com', 'b.com'], recipients: [], recipientCount: 0 }), 'a.com, b.com');
  assert.equal(destinationText({ hosts: ['a.com', 'b.com', 'c.com'], recipients: [], recipientCount: 0 }), 'a.com, b.com and 1 more');
  const p: any = { ...change, hosts: ['a.com'] };
  assert.equal(momoActionTitle(p), 'Allow MoMo to send to a.com?');
  assert.equal(momoActionWhy({ ...p, reasons: ['uncertain'] }), 'An earlier try may already have gone through.');
  assert.equal(momoActionWhy({ ...p, reasons: ['uncertain', 'egress'] }), 'This chat read your private data, and this goes somewhere new.');
  assert.deepEqual(Object.keys(SCOPE_LABEL), ['once', 'chat', 'today', '30d', 'site']);
  // a navigation (#3655): it asks to open the site, says why, and Always allow names the host
  const open: any = { ...p, opens: true, reasons: ['egress'] };
  assert.equal(momoActionTitle(open), 'Allow MoMo to open a.com?');
  assert.equal(momoActionWhy(open), 'This chat read your private data, and this site is new to it.');
  assert.equal(
    momoActionWhy({ ...open, reasons: ['egress', 'carries-data'] }),
    'This chat read your private data, and this address may carry some.',
  );
  assert.deepEqual(momoActionChoices(['once', 'site'], 'a.com').shown, [
    { scope: 'once', label: 'Allow once' },
    { scope: 'site', label: 'Always allow a.com', hint: 'Opening pages here, in every MoMo chat' },
  ]);
  assert.equal(momoActionChoices(['once', 'site']).shown[1].label, 'Always allow this site');
  assert.equal(
    momoActionWhy({ ...open, reasons: ['egress', 'many-opens'] }),
    'MoMo opened sites many times in this chat, so it asks again.',
  );
  // Always allow is the widest scope past this chat; without this chat, it is the second button
  const labels = (scopes: any[]) => {
    const c = momoActionChoices(scopes);
    return [c.shown.map((x: any) => `${x.label}:${x.scope}`), c.more.map((x: any) => x.scope)];
  };
  assert.deepEqual(labels(['once', 'today']), [['Allow once:once', 'Always allow:today'], []]);
  assert.deepEqual(momoActionChoices(['once', 'today']).shown[1].hint, 'Until tonight, in every MoMo chat');
  assert.deepEqual(labels(['once', 'chat']), [['Allow once:once', 'Allow for this chat:chat'], []]);
  assert.deepEqual(labels([]), [['Allow once:once'], []]);
});

test('#3655: an open card asks to open the site, names it, and Always allow <host> answers the site scope', async () => {
  await render({
    ...change,
    hosts: ['www.ycombinator.com'],
    opens: true,
    reasons: ['egress'],
    scopes: ['once', 'site'],
    denyAlways: false,
  });
  const card = container.querySelector('[data-kind="momoAction"]')!;
  assert.equal(card.querySelector('h3')!.textContent, 'Allow MoMo to open www.ycombinator.com?');
  assert.equal(card.querySelector('dl')!.textContent!.includes('Sitewww.ycombinator.com'), true);
  assert.deepEqual(buttons(), ['Allow once', 'Always allow www.ycombinator.com', 'Deny']);
  await key('2');
  assert.deepEqual(answers(), [{ decision: 'allow', scope: 'site' }]);
});

test('More options without Always deny holds only the other scope', async () => {
  await render({ ...change, scopes: ['once', 'today', '30d'], denyAlways: false });
  assert.deepEqual(buttons(), ['Allow once', 'Always allow', 'Deny', 'Allow today']);
  await key('2');
  assert.deepEqual(answers(), [{ decision: 'allow', scope: '30d' }]);
});

test('a momoConnect card is the connect card for its source, in the card’s place; one that names no source is not', async () => {
  const mount = async (params: any) => {
    fx.approvals = [{ id: 'sage-momoConnect-1', method: 'sage/momoConnect', params }];
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(Approvals, { threadId: 't1', cwd: '/p' })));
  };
  await mount({ kind: 'momoConnect', harness: 'claude', momoConnect: { source: 'reminders' } });
  const stub = container.querySelector('[data-stub="connect"]')!;
  assert.deepEqual([stub.getAttribute('data-id'), stub.getAttribute('data-source')], ['sage-momoConnect-1', 'reminders']);
  await act(async () => root.unmount());
  container.remove();
  await mount({ kind: 'momoConnect', harness: 'claude' });
  assert.equal(container.querySelector('[data-stub="connect"]'), null);
});

test('a send names every recipient it has, then how many more, with the total in the label (#4649 A4)', async () => {
  const recipients = ['a@x.com', 'b@x.com', 'c@x.com'];
  await render({
    ...change,
    hosts: [],
    recipients,
    recipientItems: recipients.map((label) => ({ kind: 'email', label })),
    recipientCount: 25,
    scopes: ['once'],
  });
  const card = container.querySelector('[data-kind="momoAction"]')!;
  assert.equal(card.querySelector('h3')!.textContent, 'Allow MoMo to send to a@x.com and 24 more?');
  assert.deepEqual(
    [...card.querySelectorAll('dt, dd')].map((n) => n.textContent),
    ['Notes · work', 'Write “hi” to Notes', 'To · 25', 'a@x.com, b@x.com, c@x.com and 22 more'],
  );
  assert.equal(reachCount({ hosts: ['h.com'], recipients, recipientCount: 25 }), 26);
  assert.equal(reachText({ hosts: [], recipients, recipientCount: 3, unknown: false, blocked: '' }), 'a@x.com, b@x.com, c@x.com');
});

test('a card that reaches people it cannot name says why, offers only Dismiss, and Enter allows nothing (#4649 A4)', async () => {
  for (const [blocked, why] of [
    ['no-recipients', "This reaches people but names none, so MoMo can't allow it."],
    ['unreadable-recipients', "MoMo can't read who this reaches, so it can't allow it."],
  ]) {
    await render({ ...change, blocked, scopes: [], denyAlways: false });
    const card = container.querySelector('[data-kind="momoAction"]')!;
    assert.equal(card.querySelector('h3')!.textContent, "MoMo can't tell who this reaches");
    assert.equal(card.querySelector('[data-icon]')!.getAttribute('data-icon'), 'Send');
    assert.equal(card.querySelector('p')!.textContent, why);
    assert.deepEqual(
      [...card.querySelectorAll('dd')].map((n) => n.textContent),
      ['Write “hi” to Notes', 'Nobody MoMo can name'],
    );
    assert.deepEqual(buttons(), ['Dismiss']);
    await key('Enter');
    await key('1');
    assert.deepEqual(answers(), []);
    await key('Escape');
    assert.deepEqual(answers(), [{ decision: 'deny' }]);
    fx.calls = [];
    await act(async () => root.unmount());
    container.remove();
  }
  assert.deepEqual(momoActionChoices(['once'], undefined, true), { shown: [], more: [] });
});
