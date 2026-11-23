// The approval cards above the composer (Codex, Claude Code, basic harnesses and Sage's own computer
// and browser cards), rendered from a fake store and the real session state.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import {
  mockStore,
  autoMock,
  stubComponent,
  render,
  resetStore,
  setStore,
  trustedClick,
  callsTo,
  moduleCalls,
  native,
  nativeCalls,
  impl,
  key,
  settle,
  window,
} from './support/thread-kit.ts';

mockStore();
const { fileChangeToDiff, parseUnifiedDiff } = await import('../src/lib/diff.ts');
autoMock('src/components/diff/DiffView.tsx', 'diff', { InlineDiff: stubComponent('InlineDiff'), fileChangeToDiff, parseUnifiedDiff });
autoMock('src/components/ui/Popover.tsx', 'popover', await import('./support/thread-approvals-popover.ts'));
const { useSessions } = await import('../src/store/session/useSession.ts');
const { EMPTY_SESSION } = await import('../src/store/session/sessionState.ts');
const { Approvals, ApprovalCard } = await import('../src/components/thread/Approvals.tsx');

const T = 't1';
const CWD = '/repo';
const session = (approvals: any[]) => useSessions.setState({ sessions: { [T]: { ...EMPTY_SESSION, rev: 1, approvals } } });
const answers: any[] = [];
native.computer = { answer: async (id: string, r: any) => answers.push([id, r]) > 0 };

beforeEach(() => {
  resetStore();
  useSessions.setState({ sessions: {} });
  moduleCalls.length = 0;
  nativeCalls.length = 0;
  answers.length = 0;
  for (const k of Object.keys(impl)) delete impl[k];
  impl['store:chatHarnessLabel'] = () => 'Codex';
  impl['store:chatOf'] = (id: string) => `chat:${id}`;
  impl['store:sendOrDraft'] = async () => true;
});
afterEach(() => {
  document.body.innerHTML = '';
});

const text = (el: Element | null) => el?.textContent ?? '';
const button = (host: ParentNode, label: string) =>
  [...host.querySelectorAll('button')].find((b) => text(b).startsWith(label)) as HTMLElement;
const resolved = () => callsTo('store:resolveRequest');
const press = (k: string, init: Record<string, unknown> = {}, target: EventTarget = document.body) =>
  key(target, 'keydown', { key: k, ...init });
/** A key a script made up: happy-dom leaves isTrusted unset, a browser says false. */
const untrusted = (k: string) =>
  settle(() => {
    const e = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true } as any);
    Object.defineProperty(e, 'isTrusted', { value: false });
    document.body.dispatchEvent(e as any);
  });
function type(el: Element, value: string) {
  const proto =
    el instanceof window.HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : el instanceof window.HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
  return settle(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new window.Event(el instanceof window.HTMLSelectElement ? 'change' : 'input', { bubbles: true }) as any);
  });
}
const show = async (method: string, params: any, id: string | number = 'r1') => {
  session([{ id, method, params }]);
  return render(h(Approvals, { threadId: T, cwd: CWD }));
};

/* ---------------------------------------------------------------- the stack */

test('no approvals render nothing; a harness card goes first and the rest are counted', async () => {
  const v = await render(h(Approvals, { threadId: T, cwd: CWD }));
  assert.equal(v.host.innerHTML, '');
  await settle(() =>
    session([
      { id: 's1', method: 'sage/computerAccess', params: { kind: 'computerAccess', app: { name: 'Notes' } } },
      { id: 'c1', method: 'item/commandExecution/requestApproval', params: { command: 'ls' } },
    ]),
  );
  assert.equal(text(v.$('.approval-kind')), 'Terminal');
  assert.equal(text(v.$('.approval-queue')), '1 more waiting');
  await settle(() => session([{ id: 's1', method: 'sage/computerAccess', params: { kind: 'computerAccess', app: { name: 'Notes' } } }]));
  assert.equal(text(v.$('.approval-message')), 'Allow Codex to control Notes?');
  assert.ok(!v.$('.approval-queue'));
  await v.unmount();
});

test('the asking harness is the segment that sent the request, not the chat current one', async () => {
  setStore({
    segments: {
      [T]: [
        { nativeId: 'acp:gemini:abc', harness: 'acp:gemini' },
        { nativeId: 'claude:xyz', harness: 'claude' },
      ],
    },
  });
  let v = await show('item/commandExecution/requestApproval', { threadId: 'xyz', command: 'ls' });
  assert.equal(text(v.$('.approval-message')), 'Allow Claude Code to run this command?');
  await v.unmount();
  v = await show('item/commandExecution/requestApproval', { threadId: 'acp:gemini:abc', command: 'ls' });
  assert.match(text(v.$('.approval-message')), /^Allow .+ to run this command\?$/);
  assert.doesNotMatch(text(v.$('.approval-message')), /Codex|Claude/);
  await v.unmount();
});

/* ---------------------------------------------------------------- Sage's own cards */

const sage = (params: any) => show(`sage/${params.kind}`, params, 's1');

test('computer access: levels below the asked one are locked; 1, 2, 3 and the buttons answer with the level', async () => {
  const levels = [
    { id: 'view', label: 'View' },
    { id: 'click', label: 'Click' },
    { id: 'full', label: 'Full' },
  ];
  const v = await sage({ kind: 'computerAccess', app: { name: 'Notes' }, levels, level: 'click' });
  assert.equal(text(v.$('.approval-kind')), 'Computer use');
  const radios = v.$$('[role="radio"]') as HTMLButtonElement[];
  assert.deepEqual(
    radios.map((r) => [r.disabled, r.getAttribute('aria-checked'), r.className]),
    [
      [true, 'false', ''],
      [false, 'true', 'on'],
      [false, 'false', ''],
    ],
  );
  await settle(() => radios[2].click()); // synthetic: ignored
  assert.equal(radios[2].getAttribute('aria-checked'), 'false');
  await trustedClick(radios[2]);
  assert.equal(radios[2].getAttribute('aria-checked'), 'true');
  await press('2');
  assert.deepEqual(answers.pop(), ['s1', { decision: 'allow', scope: 'chat', level: 'full' }]);
  await press('3', {}, v.$('.approval-message')!);
  assert.deepEqual(answers.pop(), ['s1', { decision: 'allow', scope: 'always', level: 'full' }]);
  await press('1');
  assert.deepEqual(answers.pop(), ['s1', { decision: 'allow', scope: 'once', level: 'full' }]);
  await press('Escape');
  assert.deepEqual(answers.pop(), ['s1', { decision: 'deny' }]);
  await press('x');
  assert.deepEqual(answers, []);
  // keys that aren't the card's: untrusted, typed in a field, under a menu, in another card
  await untrusted('1');
  const field = document.body.appendChild(document.createElement('input'));
  await press('1', {}, field);
  const layer = document.body.appendChild(document.createElement('div'));
  layer.className = 'popover-layer';
  await press('1');
  layer.remove();
  const other = document.body.appendChild(document.createElement('div'));
  other.className = 'approval-card';
  await press('1', {}, other);
  assert.deepEqual(answers, []);
  // the primary and Deny are buttons (the menu's scopes: approvalAllowAlwaysUI.test.ts)
  for (const label of ['Always allow', 'Deny']) {
    await settle(() => button(v.host, label).click());
    await trustedClick(button(v.host, label));
  }
  assert.deepEqual(answers, [
    ['s1', { decision: 'allow', scope: 'always', level: 'full' }],
    ['s1', { decision: 'deny' }],
  ]);
  await v.unmount();
});

test('a level that is not offered locks nothing; no levels, no level picker', async () => {
  let v = await sage({ kind: 'computerAccess', levels: [{ id: 'view', label: 'View' }], level: 'other' });
  assert.equal(text(v.$('.approval-message')), 'Allow Codex to control this app?');
  assert.equal((v.$('[role="radio"]') as HTMLButtonElement).disabled, false);
  await v.unmount();
  v = await sage({ kind: 'computerAccess' });
  assert.ok(!v.$('.sage-levels'));
  await v.unmount();
});

test('browser sites and screen reading say who asks for what', async () => {
  let v = await sage({ kind: 'browserOrigin', origin: 'https://example.com' });
  assert.equal(text(v.$('.approval-kind')), 'Browser');
  assert.equal(text(v.$('.approval-message')), 'Allow Codex to use https://example.com?');
  await v.unmount();
  v = await sage({ kind: 'visionConsent', app: { name: 'Notes' }, model: 'gpt-x', vendor: 'OpenAI' });
  assert.equal(text(v.$('.approval-kind')), 'Screen reading');
  assert.equal(text(v.$('.approval-message')), 'gpt-x will read screenshots of Notes for Codex. Screenshots go to OpenAI.');
  await v.unmount();
});

test('an action that cannot be undone takes a click or ⌘↩ held for a second', async () => {
  let v = await sage({
    kind: 'computerConfirm',
    app: { name: 'Mail' },
    verb: 'send',
    summary: 'the draft',
    levels: [{ id: 'full', label: 'Full' }],
  });
  assert.equal(text(v.$('.approval-message')), "Allow Codex to send in Mail? This can't be undone.");
  assert.ok(!v.$('.sage-levels'));
  await press('1');
  await press('Enter', { metaKey: true, repeat: true });
  assert.deepEqual(answers, []);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await press('Enter', { metaKey: true });
    assert.match(button(v.host, 'Allow once').className, /holding/);
    await key(document.body, 'keyup', { key: 'a' }); // not the end of the hold
    mock.timers.tick(999);
    await key(document.body, 'keyup', { key: 'Meta' });
    assert.doesNotMatch(button(v.host, 'Allow once').className, /holding/);
    mock.timers.tick(10);
    assert.deepEqual(answers, []);
    await key(document.body, 'keyup', { key: 'Enter' }); // nothing held
    await press('Enter', { metaKey: true });
    await settle(() => mock.timers.tick(1000));
    assert.deepEqual(answers.pop(), ['s1', { decision: 'allow', scope: 'once' }]);
    await press('Enter', { metaKey: true });
    await v.unmount(); // a hold in progress ends with the card
    mock.timers.tick(2000);
    assert.deepEqual(answers, []);
  } finally {
    mock.timers.reset();
  }
  v = await sage({ kind: 'computerConfirm' });
  assert.equal(text(v.$('.approval-message')), "Allow Codex to act in this app? This can't be undone.");
  await settle(() => button(v.host, 'Allow once').click());
  await trustedClick(button(v.host, 'Allow once'));
  assert.deepEqual(answers, [['s1', { decision: 'allow', scope: 'once' }]]);
  await v.unmount();
});

/* ---------------------------------------------------------------- the shared card */

test('Enter approves, Esc denies, numbers pick an option; keys elsewhere are left alone', async () => {
  const v = await show('item/commandExecution/requestApproval', { command: 'npm test' }, 7);
  assert.equal(text(v.$('.approval-cmd')), 'npm test');
  await press('Enter');
  await press('2');
  await press('3'); // only two choices
  await press('Escape');
  await press('Enter', {}, v.$('.approval-note')!);
  const layer = document.body.appendChild(document.createElement('div'));
  layer.className = 'popover-layer';
  await press('Enter');
  layer.remove();
  const other = document.body.appendChild(document.createElement('div'));
  other.className = 'approval-card';
  await press('Enter', {}, other);
  assert.deepEqual(resolved(), [
    [7, { decision: 'accept' }],
    [7, { decision: 'acceptForSession' }],
    [7, { decision: 'decline' }],
  ]);
  assert.deepEqual(callsTo('store:sendOrDraft'), []);
  await v.unmount();
});

test('a denial note goes back with a Claude Code denial, and as the next message for other harnesses', async () => {
  let v = await show('claude/toolApproval', { toolName: 'Grep', input: { pattern: 'x' } }, 'cperm-1');
  const note = () => v.$('.approval-note') as HTMLInputElement;
  await press('a', {}, note());
  await press('Enter', {}, note()); // empty note: nothing
  await type(note(), '  use rg  ');
  await press('Enter', {}, note());
  assert.deepEqual(resolved(), [['cperm-1', { decision: 'decline', reason: 'use rg' }]]);
  assert.deepEqual(callsTo('store:sendOrDraft'), []);
  await v.unmount();
  moduleCalls.length = 0;
  v = await show('item/commandExecution/requestApproval', { command: 'ls' }, 'c1');
  await type(note(), 'try dir');
  await settle(() => button(v.host, 'Deny').click());
  assert.deepEqual(resolved(), [['c1', { decision: 'decline' }]]);
  assert.deepEqual(callsTo('store:sendOrDraft'), [['chat:t1', 'try dir', { human: true }]]);
  await v.unmount();
  // a note that fails to send says so
  impl['store:sendOrDraft'] = async () => {
    throw new Error('offline');
  };
  impl['store:toastFailure'] = (what: string) => (e: Error) => moduleCalls.push(['failed', [what, e.message]]);
  v = await show('item/commandExecution/requestApproval', { command: 'ls' }, 'c2');
  await type(note(), 'try dir');
  await settle(() => button(v.host, 'Deny').click());
  assert.deepEqual(callsTo('failed'), [["Couldn't send your note", 'offline']]);
  await v.unmount();
});

test('a request with no chat keeps its note to itself', async () => {
  const v = await render(
    h(ApprovalCard, {
      // a partial Codex request: the card reads only its command
      req: { id: 'x', method: 'item/commandExecution/requestApproval', params: { command: 'ls' } as any, threadId: null, receivedAt: 0 },
      cwd: CWD,
      threadId: T,
      more: 0,
    }),
  );
  await type(v.$('.approval-note')!, 'no');
  await settle(() => button(v.host, 'Deny').click());
  assert.deepEqual(resolved(), [['x', { decision: 'decline' }]]);
  assert.deepEqual(callsTo('store:sendOrDraft'), []);
  await v.unmount();
});

test('the options menu lists every choice with its key and hint', async () => {
  const options = [
    { optionId: 'a1', name: 'Allow', kind: 'allow_once' },
    { optionId: 'a2', name: 'Always', kind: 'allow_always' },
    { optionId: 'x1', name: 'Extra one', kind: 'other' },
    { optionId: 'x2', name: 'Extra two', kind: 'other' },
    { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
  ];
  const v = await show('acp/permission', { toolCall: null, options }, 'p1');
  assert.equal(text(v.$('.approval-message')), 'Codex is asking for permission');
  assert.equal(text(v.$('.approval-kind')), 'Tool');
  assert.equal(text(v.$('.approval-detail')), ''); // nothing to show about the call
  await settle(() => (v.$('[aria-label="Approval options"]') as HTMLElement).click());
  const items = [...document.querySelectorAll('.menu-item')];
  assert.deepEqual(
    items.map((i) => [text(i.querySelector('.menu-title')), text(i.querySelector('kbd'))]),
    [
      ['Allow', '1'],
      ['Always', '2'],
      ['Extra one', '3'],
      ['Extra two', ''],
    ],
  );
  await press('Enter'); // the card leaves the keys to the menu while it is open
  assert.deepEqual(resolved(), []);
  await settle(() => (items[3] as HTMLElement).click());
  assert.deepEqual(resolved(), [['p1', { optionId: 'x2' }]]);
  assert.ok(!document.querySelector('.menu-item'));
  await settle(() => button(v.host, 'Allow').click());
  await press('Escape');
  assert.deepEqual(resolved().slice(1), [
    ['p1', { optionId: 'a1' }],
    ['p1', { optionId: 'r1' }],
  ]);
  await v.unmount();
});

test("an unsupported request can only be dismissed, and names the chat's own harness", async () => {
  impl['store:chatHarnessLabel'] = () => 'Claude Code';
  const v = await show('item/unknown', {}, 'u1');
  assert.equal(text(v.$('.approval-message')), 'Claude Code sent an unsupported request: item/unknown');
  assert.ok(!v.$('[aria-label="Approval options"]'));
  assert.ok(!v.$('.approval-detail'));
  await press('Enter');
  await press('Escape');
  assert.deepEqual(resolved(), Array(2).fill(['u1', { decision: 'cancel' }]));
  await v.unmount();
});

/* ---------------------------------------------------------------- commands */

test('command approvals: network, stdin, a reason, another folder and an exec-policy amendment', async () => {
  const cases: [any, string, string][] = [
    [{ command: 'curl x', networkApprovalContext: { host: 'example.com' } }, 'Network', 'Allow Codex to access example.com?'],
    [{ command: 'cat', kind: 'writeStdin' }, 'Terminal', 'Allow Codex to send input to this process?'],
    [{ reason: 'Needs to build' }, 'Terminal', 'Needs to build'],
  ];
  for (const [params, kind, message] of cases) {
    const v = await show('item/commandExecution/requestApproval', params);
    assert.equal(text(v.$('.approval-kind')), kind);
    assert.equal(text(v.$('.approval-message')), message);
    await v.unmount();
  }
  let v = await show('item/commandExecution/requestApproval', {});
  assert.ok(!v.$('.approval-cmd'));
  await v.unmount();
  v = await show('item/commandExecution/requestApproval', { command: 'ls', cwd: '/elsewhere' });
  assert.equal(text(v.$('.approval-cwd')), 'in /elsewhere');
  await v.unmount();
  v = await show('item/commandExecution/requestApproval', { command: 'ls', cwd: CWD });
  assert.ok(!v.$('.approval-cwd'));
  await v.unmount();
  v = await show('item/commandExecution/requestApproval', {
    command: 'npm run x',
    proposedExecpolicyAmendment: ['/bin/bash', '-lc', 'npm', 'run'],
  });
  await settle(() => (v.$('[aria-label="Approval options"]') as HTMLElement).click());
  assert.equal(text(document.querySelector('.menu-item .menu-title')), 'Allow once');
  assert.match(
    (document.querySelector('.menu-item [data-tooltip]') as HTMLElement).dataset.tooltip!,
    /^Don't ask again for commands that start with npm run/,
  );
  assert.ok(document.querySelector('.menu-item .ap-info'));
  await press('2');
  assert.deepEqual(resolved(), []); // the menu is open
  await settle(() => (document.querySelectorAll('.menu-item')[1] as HTMLElement).click());
  assert.deepEqual(resolved(), [
    ['r1', { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['/bin/bash', '-lc', 'npm', 'run'] } } }],
  ]);
  await v.unmount();
  v = await show('item/commandExecution/requestApproval', { command: 'ls', proposedExecpolicyAmendment: [] });
  await press('2');
  assert.deepEqual(resolved().pop(), ['r1', { decision: 'acceptForSession' }]);
  await v.unmount();
});

test('legacy command approvals join the argv and answer in the old words', async () => {
  let v = await show('execCommandApproval', { command: ['git', 'status'] });
  assert.equal(text(v.$('.approval-cmd')), 'git status');
  await press('Enter');
  await press('2');
  await press('Escape');
  assert.deepEqual(resolved(), [
    ['r1', { decision: 'approved' }],
    ['r1', { decision: 'approved_for_session' }],
    ['r1', { decision: { denied: { rejection: 'The user declined this request.' } } }],
  ]);
  await v.unmount();
  v = await show('execCommandApproval', {});
  assert.equal(text(v.$('.approval-cmd')), '');
  await v.unmount();
});

/* ---------------------------------------------------------------- edits */

test('edit approvals show the diffs of the item they belong to', async () => {
  const change = (path: string) => ({ path, kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b\n' });
  setStore({ runtime: { [T]: { turns: [{ items: [{ id: 'other' }, { id: 'it1', changes: [change('/repo/src/a.ts')] }] }] } } });
  let v = await show('item/fileChange/requestApproval', { itemId: 'it1' });
  assert.equal(text(v.$('.approval-message')), 'Allow Codex to edit src/a.ts?');
  assert.deepEqual(
    v.$$('[data-stub="InlineDiff"]').map((d) => [d.dataset.cwd, d.dataset.maxheight]),
    [[CWD, '220']],
  );
  await press('Enter');
  await press('2');
  await press('Escape');
  assert.deepEqual(resolved(), [
    ['r1', { decision: 'accept' }],
    ['r1', { decision: 'acceptForSession' }],
    ['r1', { decision: 'decline' }],
  ]);
  await v.unmount();
  v = await show('item/fileChange/requestApproval', { itemId: 'missing' });
  assert.equal(text(v.$('.approval-message')), 'Allow Codex to edit 0 files?');
  await v.unmount();
  v = await show('item/fileChange/requestApproval', { itemId: 'it1', grantRoot: '/repo/out' });
  assert.equal(text(v.$('.approval-message')), 'Allow Codex to write to /repo/out?');
  await v.unmount();
  setStore({ runtime: {} });
  v = await show('item/fileChange/requestApproval', { itemId: 'it1', reason: 'Fix it' });
  assert.equal(text(v.$('.approval-message')), 'Fix it');
  await v.unmount();
});

test('legacy edit approvals build diffs from their file changes', async () => {
  let v = await show('applyPatchApproval', {
    fileChanges: {
      '/repo/a.ts': { type: 'add', content: 'x\n' },
      '/repo/b.ts': { unified_diff: '@@ -1 +1 @@\n-a\n+b\n' },
      '/repo/c.ts': {},
    },
  });
  assert.equal(text(v.$('.approval-message')), 'Allow Codex to edit 3 files?');
  assert.equal(v.$$('[data-stub="InlineDiff"]').length, 3);
  await press('Enter');
  await press('2');
  await press('Escape');
  assert.deepEqual(resolved(), [
    ['r1', { decision: 'approved' }],
    ['r1', { decision: 'approved_for_session' }],
    ['r1', { decision: { denied: { rejection: 'The user declined this request.' } } }],
  ]);
  await v.unmount();
  v = await show('applyPatchApproval', {});
  assert.equal(text(v.$('.approval-message')), 'Allow Codex to edit 0 files?');
  await v.unmount();
});

/* ---------------------------------------------------------------- permissions */

test('permission requests list what they ask for and grant it for the turn or the session', async () => {
  const permissions = {
    network: { enabled: true },
    fileSystem: {
      read: ['/a'],
      write: ['/b'],
      entries: [
        { access: 'Read', path: '/c' },
        { other: 1 },
        // the protocol's FileSystemSandboxEntry: a typed path and a lowercase access mode
        { access: 'write', path: { type: 'path', path: '/d' } },
        { access: 'read', path: { type: 'glob_pattern', pattern: '/e/**' } },
        { access: 'deny', path: { type: 'special', value: { kind: 'tmpdir' } } },
      ],
    },
  };
  let v = await show('item/permissions/requestApproval', { permissions });
  assert.equal(text(v.$('.approval-message')), 'Codex is requesting additional permissions');
  assert.equal(
    text(v.$('.approval-cmd')),
    'Network access\nRead /a\nWrite /b\nRead /c\nAccess {"other":1}\nWrite /d\nRead /e/**\nDeny the temporary folder',
  );
  await press('Enter');
  await press('2');
  await press('Escape');
  assert.deepEqual(resolved(), [
    ['r1', { permissions, scope: 'turn' }],
    ['r1', { permissions, scope: 'session' }],
    ['r1', { permissions: {}, scope: 'turn' }],
  ]);
  await v.unmount();
  v = await show('item/permissions/requestApproval', { reason: 'Why', permissions: { network: { enabled: false } } });
  assert.equal(text(v.$('.approval-message')), 'Why');
  assert.equal(text(v.$('.approval-cmd')), '');
  await v.unmount();
  v = await show('item/permissions/requestApproval', {});
  assert.equal(text(v.$('.approval-cmd')), '');
  await v.unmount();
});

/* ---------------------------------------------------------------- questions */

test('questions: one at a time as Claude Code asks them, with a count, Other answers, secrets, multi-select and Skip', async () => {
  const questions = [
    {
      id: 'a',
      header: 'View',
      question: 'Which view?',
      options: [{ label: 'List', description: 'Rows' }, { label: 'Grid' }],
      isOther: true,
    },
    { id: 'b', header: 'Tags', question: 'Which tags?', options: [{ label: 'x' }, { label: 'y' }], multiSelect: true, isOther: true },
    { id: 'c', question: 'Token?', isSecret: true },
    { id: 'd', question: 'Untouched?', options: [{ label: 'p' }], multiSelect: true },
  ];
  const v = await show('item/tool/requestUserInput', { questions }, 'q1');
  const title = () => text(v.$('.question-title'));
  const field = () => v.$('.question-other-input') as HTMLInputElement;
  assert.equal(title(), 'Which view?');
  assert.equal(text(v.$('.question-count')), '1/4');
  assert.equal(text(v.$('.question-option-desc')), 'Rows');
  await settle(() => button(v.host, 'List').click());
  // several choices toggle, typed text joins them, Next moves on
  assert.equal(title(), 'Which tags?');
  const [x, y] = v.$$('.question-option:not(.question-other)') as HTMLElement[];
  await settle(() => x.click());
  await settle(() => y.click());
  await settle(() => x.click());
  assert.deepEqual(
    [x, y].map((b) => b.getAttribute('aria-pressed')),
    ['false', 'true'],
  );
  assert.match(y.className, /sel/);
  await type(field(), 'z');
  await settle(() => button(v.host, 'Next').click());
  // a secret one is masked
  assert.equal(title(), 'Token?');
  assert.equal(field().getAttribute('type'), 'password');
  await type(field(), 's3cret');
  await press('a', {}, field());
  await press('Enter', {}, field());
  assert.equal(title(), 'Untouched?');
  await settle(() => button(v.host, 'Skip').click());
  assert.deepEqual(resolved(), [
    [
      'q1',
      {
        answers: {
          a: { answers: ['List'] },
          b: { answers: ['y', 'z'] },
          c: { answers: ['s3cret'] },
          d: { answers: ['[No preference]'] },
        },
      },
    ],
  ]);
  await v.unmount();
});

test('a question card with no questions is answered at once, as Claude Code does', async () => {
  const v = await show('item/tool/requestUserInput', {}, 'q2');
  assert.ok(!v.$('.question-card'));
  assert.deepEqual(resolved(), [['q2', { answers: {} }]]);
  await v.unmount();
});

/* ---------------------------------------------------------------- MCP elicitation */

test('an MCP form takes checkboxes, choices, numbers and text, and can be declined', async () => {
  const requestedSchema = {
    properties: {
      ok: { type: 'boolean', title: 'OK?' },
      color: { type: 'string', enum: ['red', 'blue'] },
      n: { type: 'number' },
      i: { type: 'integer' },
      name: { type: 'string' },
    },
  };
  const v = await show('mcpServer/elicitation/request', { serverName: 'srv', message: 'Fill in', requestedSchema }, 'e1');
  assert.equal(text(v.$('.approval-title')), 'srv needs input');
  assert.equal(text(v.$('.approval-subtitle')), 'Fill in');
  assert.deepEqual(v.$$('.form-field > span').map(text), ['OK?', 'color', 'n', 'i', 'name']);
  const [ok, n, i, name] = v.$$('input') as HTMLInputElement[];
  assert.deepEqual([n.type, i.type, name.type], ['number', 'number', 'text']);
  await settle(() => ok.click());
  await type(v.$('select')!, 'blue');
  await type(n, '1.5');
  await type(i, '3');
  await type(name, 'Bo');
  await settle(() => button(v.host, 'Submit').click());
  await settle(() => button(v.host, 'Decline').click());
  assert.deepEqual(resolved(), [
    ['e1', { action: 'accept', content: { ok: true, color: 'blue', n: 1.5, i: 3, name: 'Bo' }, _meta: null }],
    ['e1', { action: 'decline', content: null, _meta: null }],
  ]);
  await v.unmount();
});

test('an MCP link opens outside the app and is answered with Done', async () => {
  let v = await show(
    'mcpServer/elicitation/request',
    { serverName: 'srv', message: 'Sign in', mode: 'url', url: 'https://auth.example' },
    'e2',
  );
  await settle(() => button(v.host, 'Open https://auth.example').click());
  assert.deepEqual(
    nativeCalls.filter((c) => c.path === 'native.shell.openExternal').map((c) => c.args),
    [['https://auth.example']],
  );
  await settle(() => button(v.host, 'Done').click());
  assert.deepEqual(resolved(), [['e2', { action: 'accept', content: null, _meta: null }]]);
  await v.unmount();
  v = await show('mcpServer/elicitation/request', { serverName: 'srv' }, 'e3');
  assert.ok(!v.$('.form-field'));
  await settle(() => button(v.host, 'Submit').click());
  assert.deepEqual(resolved()[1], ['e3', { action: 'accept', content: {}, _meta: null }]);
  await v.unmount();
  // Claude's link request without a URL (main keeps a missing one as null): Open has nothing to open
  nativeCalls.length = 0;
  v = await show(
    'mcpServer/elicitation/request',
    { serverName: 'srv', message: 'Sign in', mode: 'url', url: null, claude: true },
    'cperm-e4',
  );
  await settle(() => button(v.host, 'Open').click());
  assert.deepEqual(
    nativeCalls.filter((c) => c.path === 'native.shell.openExternal').map((c) => c.args),
    [['']],
  );
  await v.unmount();
});

/* ---------------------------------------------------------------- basic harnesses */

test('basic harness permissions show the tool call as an edit, a command, a fetch or raw input', async () => {
  const options = [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }];
  let v = await show('acp/permission', {
    options,
    toolCall: { toolCallId: 'tc', title: 'Edit a.ts', content: [{ type: 'diff', path: '/repo/a.ts', oldText: null, newText: 'x' }] },
  });
  assert.equal(text(v.$('.approval-kind')), 'Edit');
  assert.equal(text(v.$('.approval-message')), 'Codex wants to: Edit a.ts');
  assert.equal(v.$$('[data-stub="InlineDiff"]').length, 1);
  assert.ok(!v.$('.approval-cmd'));
  await v.unmount();
  v = await show('acp/permission', { options, toolCall: { kind: 'execute', title: 'Run', rawInput: { command: 'make' } } });
  assert.equal(text(v.$('.approval-kind')), 'Terminal');
  assert.equal(text(v.$('.approval-cmd')), 'make');
  await v.unmount();
  v = await show('acp/permission', { options, toolCall: { kind: 'fetch', rawInput: { url: 'https://x.dev' } } });
  assert.equal(text(v.$('.approval-kind')), 'Network');
  assert.equal(text(v.$('.approval-cmd')), JSON.stringify({ url: 'https://x.dev' }, null, 2));
  await v.unmount();
  v = await show('acp/permission', { options, toolCall: { kind: 'read', title: 'Read a', rawInput: { path: '/a' } } });
  assert.equal(text(v.$('.approval-kind')), 'Tool');
  assert.equal(text(v.$('.approval-cmd')), JSON.stringify({ path: '/a' }, null, 2));
  await press('Enter');
  await press('Escape');
  assert.deepEqual(resolved(), [
    ['r1', { optionId: 'ok' }],
    ['r1', { optionId: null }],
  ]);
  await v.unmount();
});

/* ---------------------------------------------------------------- Claude Code tools */

test('Claude Code plan approval only asks: the plan card above names the file, never its app-data path here (#1933)', async () => {
  const planFilePath = '/Users/me/Library/Application Support/MoPilot Code/claude-accounts/a1/plans/p.md';
  const v = await show('claude/toolApproval', { toolName: 'ExitPlanMode', input: { planFilePath } }, 'cperm-2');
  assert.equal(text(v.$('.approval-kind')), 'Plan');
  assert.ok(!v.$('.approval-cwd'));
  assert.ok(!v.$('.approval-detail'));
  assert.ok(!v.host.textContent?.includes('claude-accounts'));
  assert.ok(!v.$('[aria-label="Approval options"]'));
  await press('Enter');
  assert.deepEqual(resolved(), [['cperm-2', { decision: 'accept' }]]);
  await v.unmount();
});

test('Claude Code tools: MCP names, web fetches, titles, reasons and blocked paths', async () => {
  let v = await show('claude/toolApproval', { toolName: 'mcp__github__get__issue', input: { n: 1 }, blockedPath: '/etc' });
  assert.equal(text(v.$('.approval-kind')), 'Tool');
  assert.equal(text(v.$('.approval-message')), 'Allow Claude Code to use github · get__issue?');
  assert.equal(text(v.$('.approval-cmd')), JSON.stringify({ n: 1 }, null, 2));
  assert.equal(text(v.$('.approval-cwd')), 'needs access to /etc');
  await press('2');
  assert.deepEqual(resolved(), [['r1', { decision: 'acceptForSession' }]]);
  await v.unmount();
  v = await show('claude/toolApproval', { toolName: 'WebFetch', input: { url: 'https://a.dev' } });
  assert.equal(text(v.$('.approval-kind')), 'Network');
  assert.equal(text(v.$('.approval-message')), 'Allow Claude Code to fetch https://a.dev?');
  assert.ok(!v.$('.approval-cmd'));
  await v.unmount();
  v = await show('claude/toolApproval', { toolName: 'WebFetch', title: 'Fetch it' });
  assert.equal(text(v.$('.approval-message')), 'Fetch it');
  assert.equal(text(v.$('.approval-cmd')), '{}');
  await v.unmount();
  v = await show('claude/toolApproval', { toolName: 'Task', reason: 'Because' });
  assert.equal(text(v.$('.approval-message')), 'Because');
  await v.unmount();
  v = await show('claude/toolApproval', { toolName: 'Task' });
  assert.equal(text(v.$('.approval-message')), 'Allow Claude Code to use Task?');
  await v.unmount();
});

test('approval answers are isolated across chats and differently typed request ids', async () => {
  for (const change of ['chat', 'id-type']) {
    const request = (id: string | number) => ({
      id,
      method: 'item/tool/requestUserInput',
      params: { questions: [{ id: 'q', question: 'Your answer?' }] },
    });
    await settle(() =>
      useSessions.setState({
        sessions: {
          t1: { ...EMPTY_SESSION, approvals: [request(7)] },
          t2: { ...EMPTY_SESSION, approvals: [request(7)] },
        },
      }),
    );
    const v = await render(h(Approvals, { threadId: 't1', cwd: CWD }));
    try {
      await type(v.$('textarea')!, 'answer for the first request');
      await v.rerender(h(Approvals, { threadId: 't1', cwd: CWD }));
      assert.equal((v.$('textarea') as HTMLTextAreaElement).value, 'answer for the first request');
      assert.equal((button(v.host, 'Submit') as HTMLButtonElement).disabled, false);
      if (change === 'chat') await v.rerender(h(Approvals, { threadId: 't2', cwd: CWD }));
      else await settle(() => useSessions.setState({ sessions: { t1: { ...EMPTY_SESSION, approvals: [request('7')] } } }));
      assert.equal((v.$('textarea') as HTMLTextAreaElement).value, '');
      assert.equal((button(v.host, 'Submit') as HTMLButtonElement).disabled, true);
    } finally {
      await v.unmount();
    }
  }
});

test('MCP schema property names do not inherit defaults or disappear from accepted content', async () => {
  const requestedSchema = {
    properties: Object.fromEntries([
      ['__proto__', { type: 'boolean' }],
      ['constructor', { type: 'string' }],
      ['toString', { type: 'string', enum: ['blue', 'red'] }],
      ['hasOwnProperty', { type: 'number' }],
    ]),
  };
  const v = await show('mcpServer/elicitation/request', { serverName: 'srv', requestedSchema }, 'named-fields');
  try {
    const [check, name, number] = v.$$('input') as HTMLInputElement[];
    assert.equal(check.checked, false);
    assert.equal(name.value, '');
    assert.equal(number.value, '');
    assert.equal((v.$('select') as HTMLSelectElement).value, '');
    await type(name, 'typed value');
    assert.equal(check.checked, false);
    await settle(() => check.click());
    await type(v.$('select')!, 'blue');
    await type(number, '12');
    await settle(() => button(v.host, 'Submit').click());
    const content = Object.fromEntries([
      ['__proto__', true],
      ['constructor', 'typed value'],
      ['toString', 'blue'],
      ['hasOwnProperty', 12],
    ]);
    assert.deepEqual(resolved(), [['named-fields', { action: 'accept', content, _meta: null }]]);
    assert.deepEqual(JSON.parse(JSON.stringify(resolved()[0][1])).content, content);
  } finally {
    await v.unmount();
  }
});

test('clearing numeric MCP fields restores unanswered values while an entered zero stays zero', async () => {
  const requestedSchema = { properties: { n: { type: 'number' }, i: { type: 'integer' }, note: { type: 'string' } } };
  const v = await show('mcpServer/elicitation/request', { serverName: 'srv', requestedSchema }, 'numbers');
  try {
    const [n, i, note] = v.$$('input') as HTMLInputElement[];
    await type(n, '1.5');
    await type(i, '3');
    await type(note, 'keep this');
    await type(n, '');
    await type(i, '');
    assert.equal(n.value, '');
    assert.equal(i.value, '');
    await settle(() => button(v.host, 'Submit').click());
    assert.deepEqual(resolved()[0], ['numbers', { action: 'accept', content: { note: 'keep this' }, _meta: null }]);
    await type(n, '0');
    await type(i, '0');
    await settle(() => button(v.host, 'Submit').click());
    assert.deepEqual(resolved()[1], ['numbers', { action: 'accept', content: { n: 0, i: 0, note: 'keep this' }, _meta: null }]);
  } finally {
    await v.unmount();
  }
});
