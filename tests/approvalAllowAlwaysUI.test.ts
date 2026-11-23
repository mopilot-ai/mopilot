import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { iconStubs, mockSource, popoverStubs, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

// Renders the real Approvals component (and through it SageApprovalCard) with its app modules stubbed:
// the card's "Always allow" choice and its number keys follow params.allowAlways.
const fixture: any = { approvals: [], answers: [] };
const noop = (names: string) => Object.fromEntries(names.split(',').map((n) => [n, () => null]));
stubStore({
  useStore: (sel: any) => sel({ segments: {}, runtime: {} }),
  resolveRequest: () => {},
  sendOrDraft: async () => {},
  toastFailure: () => () => {},
  chatHarnessLabel: () => 'Codex',
  chatOf: (id: string) => id,
  interrupt: () => {},
  toast: () => {},
});
mockSource('src/lib/format.ts', noop('prettyCommand'));
mockSource('src/lib/paths.ts', noop('relPath'));
mockSource('src/session/open.ts', noop('openLink'));
mockSource('src/components/diff/DiffView.tsx', noop('InlineDiff,fileChangeToDiff'));
mockSource('src/components/ui/Popover.tsx', popoverStubs());
installNativeStub({ computer: { answer: async (id: string, r: any) => fixture.answers.push([id, r]) > 0 } });
mockSource('src/components/ui/icons.tsx', iconStubs());
mockSource('src/harness/acpTranslate.ts', noop('permissionChoices,toolItem'));
mockSource('src/store/session/useSession.ts', {
  useSession: () => ({ approvals: fixture.approvals }),
  useSessionField: (id: any, pick: any) => pick(((() => ({ approvals: fixture.approvals })) as (id: any) => any)(id)),
});
mockSource('src/harness/approvalRequests.ts', { requestsOf: () => [] });
mockSource(
  'src/harness/elicitation.ts',
  noop('elicitationAnswer,nativeAppAnswer,nativeAppApproval,browserUseApproval,browserUseAnswer,allowsAllSites'),
);
mockSource('src/harness/chromeApproval.ts', noop('chromeApproval,chromeSuggestion,chromeTabUrl,chromeTool'));
mockSource('src/harness/adapters/codexApi.ts', { codexApi: { configRequirementsRead: async () => null } });
mockSource('src/session/harness/acp.ts', noop('acpLabelOf'));
mockSource('src/harness/copy.ts', noop('copy'));
mockSource('src/lib/focus.ts', noop('isEnter'));
mockSource('src/components/thread/QuestionCard.tsx', noop('QuestionCard'));
// the switch's own rules are autoSwitchUI.test.ts; here, where the card offers it and what its pick answers
mockSource('src/components/thread/approvals/autoSwitch.tsx', {
  AutoSwitchItem: ({ onAllow }: any) => createElement('button', { role: 'menuitem', onClick: onAllow }, 'Allow and switch to Auto'),
});
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Approvals } = await import('../src/components/thread/Approvals.tsx');

const loopback = {
  kind: 'browserOrigin',
  origin: 'http://localhost:5173',
  allowAlways: false,
  level: 'read',
  levels: [
    { id: 'read', label: 'Read only' },
    { id: 'write', label: 'Read and write' },
  ],
};
const site = { ...loopback, origin: 'https://example.test', allowAlways: undefined };

async function mount(params: any, id = 'ask-1') {
  fixture.approvals = [{ id, method: 'sage/browserOrigin', params }];
  fixture.answers = [];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  await act(() => root.render(createElement(Approvals, { threadId: 'chat1', cwd: '/repo' })));
  const labels = () => [...host.querySelectorAll('.approval-foot button')].map((b) => b.textContent);
  const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text)) as any;
  // the card counts only a person's clicks (isTrusted); happy-dom leaves it unset on dispatched events
  const click = async (el: any, trusted = true) =>
    act(() => {
      const ev = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'isTrusted', { value: trusted });
      el.dispatchEvent(ev);
    });
  const key = async (value: string, init = {}) =>
    act(() => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init }));
    });
  return {
    host,
    labels,
    button,
    click,
    key,
    dispose: async () => {
      await act(() => root.unmount());
      host.remove();
    },
  };
}

/** The footer's buttons and, once the chevron is open, the menu's choices. */
const menuLabels = (host: any) => [...host.querySelectorAll('[role=menuitem]')].map((b: any) => b.textContent);
const chevron = (host: any) => host.querySelector('.approval-foot .chevron');

test('a loopback site card: the question, no Always allow, Allow in this chat as the primary and Allow once in its menu', async () => {
  const f = await mount(loopback);
  try {
    assert.equal(f.host.querySelector('.approval-message')!.textContent, 'Allow Codex to use http://localhost:5173?');
    assert.equal(f.host.querySelector('.approval-explain'), null, 'the question alone, no line under it');
    assert.equal(f.host.querySelector('.ap-btn.allow')!.hasAttribute('title'), false, 'no Always allow, so nothing saved to name');
    assert.deepEqual(f.labels(), ['Deny Esc', 'Allow in this chat 2', '']);
    await f.click(chevron(f.host));
    assert.deepEqual(menuLabels(f.host), ['Allow once⌘⏎', 'Allow and switch to Auto']);
    assert.equal(f.button('Always allow') === undefined, true);
  } finally {
    await f.dispose();
  }
});

test('on a loopback site card key 3 and ⇧⌘↩ do nothing; 1, 2 and ⌘↩ still answer', async () => {
  const f = await mount(loopback);
  try {
    await f.key('3');
    await f.key('Enter', { metaKey: true, shiftKey: true });
    assert.deepEqual(fixture.answers, []);
    await f.key('2');
    assert.deepEqual(fixture.answers, [['ask-1', { decision: 'allow', scope: 'chat', level: 'read' }]]);
    await f.key('1');
    assert.deepEqual(fixture.answers.at(-1), ['ask-1', { decision: 'allow', scope: 'once', level: 'read' }]);
    await f.key('Enter', { metaKey: true });
    assert.deepEqual(fixture.answers.at(-1), ['ask-1', { decision: 'allow', scope: 'once', level: 'read' }]);
    assert.equal(fixture.answers.length, 3);
  } finally {
    await f.dispose();
  }
});

test('on a loopback site card the chosen level travels with a clicked scope', async () => {
  const f = await mount(loopback);
  try {
    await f.click(f.button('Read and write'));
    await f.click(f.button('Allow in this chat'));
    assert.deepEqual(fixture.answers, [['ask-1', { decision: 'allow', scope: 'chat', level: 'write' }]]);
  } finally {
    await f.dispose();
  }
});

test('a site card without allowAlways: Always allow is the primary, Allow once and Allow in this chat are in its menu', async () => {
  const f = await mount(site);
  try {
    assert.deepEqual(f.labels(), ['Deny Esc', 'Always allow ⇧⌘⏎', '']);
    assert.equal(f.host.querySelector('.ap-btn.allow')!.getAttribute('title'), 'Saved on this device. Remove in Settings → Browser.');
    await f.click(f.button('Always allow'), false);
    await f.click(chevron(f.host), false);
    assert.deepEqual(fixture.answers, [], 'a synthetic click is ignored');
    assert.deepEqual(menuLabels(f.host), [], 'and opens no menu');
    await f.click(f.button('Always allow'));
    assert.deepEqual(fixture.answers, [['ask-1', { decision: 'allow', scope: 'always', level: 'read' }]]);
    await f.click(chevron(f.host));
    assert.deepEqual(menuLabels(f.host), ['Allow once⌘⏎', 'Allow in this chat2', 'Allow and switch to Auto']);
    await f.click(f.host.querySelectorAll('[role=menuitem]')[1]);
    assert.deepEqual(fixture.answers.at(-1), ['ask-1', { decision: 'allow', scope: 'chat', level: 'read' }]);
    await f.click(chevron(f.host));
    await f.click(f.host.querySelectorAll('[role=menuitem]')[0]);
    assert.deepEqual(fixture.answers.at(-1), ['ask-1', { decision: 'allow', scope: 'once', level: 'read' }]);
  } finally {
    await f.dispose();
  }
});

test('a site card without allowAlways answers Always allow on key 3 and on ⇧⌘↩; a repeated or synthetic chord does nothing', async () => {
  const f = await mount(site);
  try {
    await f.key('Enter', { metaKey: true, shiftKey: true, repeat: true });
    assert.deepEqual(fixture.answers, []);
    await f.key('3');
    await f.key('Enter', { metaKey: true, shiftKey: true });
    assert.deepEqual(fixture.answers, [
      ['ask-1', { decision: 'allow', scope: 'always', level: 'read' }],
      ['ask-1', { decision: 'allow', scope: 'always', level: 'read' }],
    ]);
  } finally {
    await f.dispose();
  }
});

test("a local server card (allowAlways 'read') offers Always allow while read is the level picked, never for write", async () => {
  const f = await mount({ ...loopback, allowAlways: 'read' });
  try {
    assert.deepEqual(f.labels(), ['Deny Esc', 'Always allow ⇧⌘⏎', '']);
    await f.key('3');
    assert.deepEqual(fixture.answers, [['ask-1', { decision: 'allow', scope: 'always', level: 'read' }]]);
    await f.click(f.button('Read and write'));
    assert.deepEqual(f.labels(), ['Deny Esc', 'Allow in this chat 2', '']);
    await f.key('3');
    await f.key('Enter', { metaKey: true, shiftKey: true });
    assert.equal(fixture.answers.length, 1, 'no Always allow while write is picked');
  } finally {
    await f.dispose();
  }
});

test('allowAlways true keeps Always allow on a computer-use card, which says where it is saved', async () => {
  const f = await mount({ kind: 'computerAccess', app: { name: 'Notes' }, allowAlways: true }, 'ask-2');
  try {
    assert.equal(f.host.querySelector('.approval-message')!.textContent, 'Allow Codex to control Notes?');
    assert.equal(f.host.querySelector('.approval-explain'), null);
    assert.equal(f.host.querySelector('.ap-btn.allow')!.getAttribute('title'), 'Saved for every chat. Remove in Settings → Computer use.');
    await f.key('3');
    assert.deepEqual(fixture.answers, [['ask-2', { decision: 'allow', scope: 'always', level: undefined }]]);
  } finally {
    await f.dispose();
  }
});

test('a card a paired computer raised says which computer, and offers no Always allow (#1364)', async () => {
  const f = await mount({ ...site, remote: { host: 'h1', hostName: 'Studio' } });
  try {
    assert.match(
      f.host.querySelector('[data-testid=approval-remote]')!.textContent!,
      /On Studio, a paired computer\. Your answer goes there\./,
    );
    assert.deepEqual(f.labels(), ['Deny Esc', 'Allow in this chat 2', '']);
    await f.click(chevron(f.host));
    // no switch to Auto: the paired computer keeps its remote owners at Ask
    assert.deepEqual(menuLabels(f.host), ['Allow once⌘⏎']);
    await f.key('3');
    assert.deepEqual(fixture.answers, []);
  } finally {
    await f.dispose();
  }
  // a card about this Mac has no such mark
  const g = await mount(site, 'ask-2');
  try {
    assert.equal(g.host.querySelector('[data-testid=approval-remote]'), null);
  } finally {
    await g.dispose();
  }
});

test("a paired computer's app card says which computer and offers no Always allow (#1364)", async () => {
  fixture.approvals = [];
  const apps = [{ bundleId: 'com.apple.Notes', name: 'Notes', tier: 'full' }];
  const remote = await (async () => {
    fixture.approvals = [
      {
        id: 'set-1',
        method: 'sage/computerAccessSet',
        params: { kind: 'computerAccessSet', apps, remote: { host: 'h1', hostName: 'Studio' } },
      },
    ];
    fixture.answers = [];
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host as any);
    await act(() => root.render(createElement(Approvals, { threadId: 'chat1', cwd: '/repo' })));
    return { host, root };
  })();
  try {
    assert.match(remote.host.querySelector('[data-testid=approval-remote]')!.textContent!, /On Studio/);
    assert.equal(
      [...remote.host.querySelectorAll('button')].some((b) => b.textContent === 'Always allow'),
      false,
    );
  } finally {
    await act(() => remote.root.unmount());
    remote.host.remove();
  }
});

test('an app card answers a menu pick with the level picked, and a chord from a focused Deny is left to the button', async () => {
  const levels = [
    { id: 'click', label: 'Click' },
    { id: 'full', label: 'Full control' },
  ];
  const f = await mount({ kind: 'computerAccess', app: { name: 'Notes' }, level: 'click', levels }, 'ask-3');
  try {
    await f.click(f.button('Full control'));
    await f.click(chevron(f.host));
    await f.click(f.host.querySelectorAll('[role=menuitem]')[1]);
    await f.click(chevron(f.host));
    await f.click(f.host.querySelectorAll('[role=menuitem]')[0]);
    assert.deepEqual(fixture.answers, [
      ['ask-3', { decision: 'allow', scope: 'chat', level: 'full' }],
      ['ask-3', { decision: 'allow', scope: 'once', level: 'full' }],
    ]);
    const deny = f.button('Deny');
    await act(() => {
      deny.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
    });
    assert.equal(fixture.answers.length, 2);
  } finally {
    await f.dispose();
  }
});

test('Allow and switch to Auto answers this step once with the switch, at the level picked; a risky site and an app card offer no switch', async () => {
  let f = await mount(site, 'ask-4');
  try {
    await f.click(f.button('Read and write'));
    await f.click(chevron(f.host));
    await f.click(f.host.querySelectorAll('[role=menuitem]')[2]);
    assert.deepEqual(fixture.answers, [['ask-4', { decision: 'allow', scope: 'once', level: 'write', then: 'auto' }]]);
  } finally {
    await f.dispose();
  }
  f = await mount(
    { ...site, allowAlways: false, risk: { level: 'high', label: 'Banking site', explanation: 'A financial site.' } },
    'ask-5',
  );
  try {
    await f.click(chevron(f.host));
    assert.deepEqual(menuLabels(f.host), ['Allow once⌘⏎']);
  } finally {
    await f.dispose();
  }
  f = await mount({ kind: 'computerAccess', app: { name: 'Notes' } }, 'ask-6');
  try {
    await f.click(chevron(f.host));
    assert.deepEqual(menuLabels(f.host), ['Allow once⌘⏎', 'Allow in this chat2']);
  } finally {
    await f.dispose();
  }
});

test('a site card of a chat that runs on a machine says the page is on that machine', async () => {
  const on = await mount({ ...site, onMachine: 'build-box' });
  try {
    assert.equal(on.host.querySelector('[data-testid=approval-machine]')!.textContent, 'The page is on build-box, not on this Mac.');
  } finally {
    await on.dispose();
  }
  const here = await mount(site);
  try {
    assert.equal(here.host.querySelector('[data-testid=approval-machine]'), null);
  } finally {
    await here.dispose();
  }
});
