// The notice in place of the composer while the harness a chat's next message goes to is down
// (src/components/thread/HarnessDownNotice.tsx, ComposerArea.tsx): the chat can't send, what is shown came from disk,
// and the ways forward: restart that harness, or continue in another usable one through the switch sheet.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, fakeStore, mockTsx, mount } from './support/composer-kit.ts';
import { stubStore } from './support/stubs.ts';

const store = fakeStore<any>({});
const toasts: any[] = [];
let session: any = { pendingSwitch: null };
let restarts = 0;
let restartFails = false;
const selections: any[] = [];
const applied: any[] = [];
const cleared: string[] = [];
let models: Record<string, any> = {};

stubStore({
  useStore: store.useStore,
  chatHarnessLabel: (id: string) => `label of ${id}`,
  harnessUsable: (h: string, s: any) => s.usable.includes(h),
  toast: (...a: any[]) => toasts.push(a),
  toastFailure: (what: string) => (e: any) => toasts.push([`${what}: ${e.message}`, 'error']),
});
mock.module('../src/store/harnessDown.ts', {
  namedExports: {
    HARNESS_DOWN: {
      codex: {
        down: (s: any) => s.codexDown,
        restart: async () => {
          restarts++;
          if (restartFails) throw new Error('main refused');
        },
      },
      claude: { down: (s: any) => !!s.claudeDown, restart: null },
      acp: { down: (s: any) => !!s.acpDown, restart: null },
    },
  },
});
mock.module('../src/store/session/useSession.ts', {
  namedExports: {
    flushSessionPatches: () => {},
    useSession: () => session,
    useSessionField: (id: any, pick: any) => pick(((() => session) as (id: any) => any)(id)),
  },
});
mock.module('../src/session/harness/select.ts', { namedExports: { setSelection: (...a: any[]) => selections.push(a) } });
mock.module('../src/components/harnessPicker/applySwitch.ts', {
  namedExports: {
    switchModel: (h: string) => models[h],
    applySwitch: async (threadId: string, target: any, c: any, select: (e: string | null) => void) => {
      applied.push([threadId, target, c]);
      select(c.effort);
    },
  },
});
const { createElement: h } = await import('react');
mockTsx(new URL('../src/components/ui/Popover.tsx', import.meta.url), {
  Popover: ({ children, onClose }: any) => h('div', { className: 'pop' }, children, h('button', { className: 'away', onClick: onClose })),
});
mockTsx(new URL('../src/components/harnessPicker/SwitchSheet.tsx', import.meta.url), {
  SwitchSheet: (p: any) =>
    h(
      'div',
      { className: 'sheet' },
      `${p.from}->${p.target} on ${p.model.id}`,
      h('button', {
        className: 'ok',
        onClick: () => p.onConfirm({ mode: 'auto', effort: 'high', queued: 'send', goal: null, multiAgent: false }),
      }),
      h('button', { className: 'no', onClick: p.onCancel }),
    ),
});
mockTsx(new URL('../src/components/composer/QueuedList.tsx', import.meta.url), {
  QueuedList: ({ threadId }: any) => h('div', { className: 'queue' }, `queue of ${threadId}`),
});
mockTsx(new URL('../src/components/harnessPicker/SwitchChip.tsx', import.meta.url), {
  clearPendingSwitch: (id: string) => cleared.push(id),
});
mockTsx(new URL('../src/components/ui/icons.tsx', import.meta.url), { AlertTriangle: () => null, Lock: () => null });
for (const [file, name] of [
  ['composer/Composer', 'Composer'],
  ['thread/PrMonitorAlerts', 'PrMonitorAlerts'],
  ['thread/NeedsYouStrip', 'NeedsYouStrip'],
  ['thread/AcpQuestions', 'AcpQuestions'],
  ['thread/Approvals', 'Approvals'],
  ['thread/ElsewhereNotice', 'ElsewhereNotice'],
  ['thread/StatusStrip', 'StatusStrip'],
  ['tasks/TaskPolling', 'TaskPolling'],
  ['thread/WorkingIn', 'WorkingInStack'],
  ['browser/ClaudeInChromeNote', 'ClaudeInChromeNote'],
  ['thread/DockedQuestions', 'DockedQuestions'],
])
  mockTsx(new URL(`../src/components/${file}.tsx`, import.meta.url), {
    [name]: (p: any) =>
      name === 'Composer'
        ? h('div', { className: 'composer' })
        : name === 'DockedQuestions'
          ? h('div', { className: 'docked' }, p.item.id)
          : name === 'Approvals'
            ? h('div', { className: 'approvals' })
            : null,
  });
const { HarnessDownNotice } = await import('../src/components/thread/HarnessDownNotice.tsx');
const { ComposerArea } = await import('../src/components/thread/ComposerArea.tsx');

test('a pending ACP switch restores the composer even while the previous Codex harness is down', async () => {
  store.setState({ codexDown: true, acpDown: false, usable: [], segments: { c: seg('codex') }, runtime: {}, pending: [] });
  session = { pendingSwitch: { harness: 'acp:opencode', model: '' } };
  await area();
  assert.ok($('.composer'));
  assert.equal($('.elsewhere-notice'), null);
});

/** Render `el` in place of what the test rendered last. */
let last: Awaited<ReturnType<typeof mount>> | null = null;
const show = async (el: any) => {
  await last?.unmount();
  last = await mount(el);
  return last;
};
const seg = (harness: string) => [{ harness, nativeId: harness === 'claude' ? 'claude:s' : 'n', start: 0 }];
beforeEach(async () => {
  await last?.unmount();
  last = null;
  store.setState({ codexDown: true, claudeDown: false, acpDown: false, usable: ['claude'], runtime: {}, segments: { c: seg('codex') } });
  session = { pendingSwitch: null };
  restarts = 0;
  restartFails = false;
  toasts.length = 0;
  selections.length = 0;
  applied.length = 0;
  cleared.length = 0;
  models = { claude: { id: 'opus', fast: false }, codex: { id: 'gpt', fast: true } };
});
const area = (o: any = {}) =>
  show(h(ComposerArea, { threadId: 'c', cwd: '/w', inPane: false, readOnly: false, composer: true, hasApproval: false, ...o }));

test('Codex down: the composer gives way to a notice that the chat cannot send, with Restart and Continue', async () => {
  await area();
  assert.equal($('.composer'), null);
  // what the chat queued stays in view above the notice
  assert.equal($('.queue').textContent, 'queue of c');
  assert.match($('.elsewhere-notice').textContent!, /Codex isn't running, so this chat can't send\./);
  assert.deepEqual(
    $$('.elsewhere-actions button').map((b) => b.textContent),
    ['Restart Codex', 'Continue in Claude Code'],
  );
  // nothing said of disk until the chat's history was read from it
  assert.equal($('.elsewhere-body'), null);
  store.setState({ runtime: { c: { fromDisk: true } } });
  await show(h(HarnessDownNotice, { threadId: 'c', family: 'codex' }));
  assert.match($('.elsewhere-body').textContent!, /read from disk until it runs again/);
});

test('Codex up, or the chat read-only, or no composer: no notice', async () => {
  store.setState({ codexDown: false });
  await area();
  assert.ok($('.composer'));
  assert.equal($('.elsewhere-notice'), null);
  store.setState({ codexDown: true });
  await area({ composer: false });
  assert.equal($('.elsewhere-notice'), null);
  await area({ readOnly: true });
  assert.equal($('.elsewhere-notice'), null);
  assert.match($('.read-only-note').textContent!, /A sub-agent's thread · Read only\./);
  // a read-only view with its own note (Ask MoMo in Quick Chat) says that instead
  await area({ readOnly: true, readOnlyNote: 'Answer in MoMo.' });
  assert.equal($('.read-only-note').textContent!.trim(), 'Answer in MoMo.');
  // an approval in its place stays
  await area({ hasApproval: true });
  assert.equal($('.elsewhere-notice'), null);
});

test('Restart starts the harness again; a restart main refuses is said', async () => {
  await show(h(HarnessDownNotice, { threadId: 'c', family: 'codex' }));
  await click($('.elsewhere-actions button'));
  assert.equal(restarts, 1);
  restartFails = true;
  await click($('.elsewhere-actions button'));
  assert.deepEqual(toasts.at(-1), ["Couldn't restart Codex: main refused", 'error']);
});

test('Continue in another harness opens the switch sheet, and confirming it records the switch for the next message', async () => {
  await show(h(HarnessDownNotice, { threadId: 'c', family: 'codex' }));
  await click($$('.elsewhere-actions button')[1]);
  assert.equal($('.sheet').textContent, 'codex->claude on opus');
  await click($('.no'));
  assert.equal($('.sheet'), null);
  // a click away closes it too
  await click($$('.elsewhere-actions button')[1]);
  await click($('.away'));
  assert.equal($('.sheet'), null);
  await click($$('.elsewhere-actions button')[1]);
  await click($('.ok'));
  assert.equal($('.sheet'), null);
  assert.deepEqual(applied, [
    ['c', { target: 'claude', model: models.claude }, { mode: 'auto', effort: 'high', queued: 'send', goal: null, multiAgent: false }],
  ]);
  // the target's model and effort, its Fast off where the model has none
  assert.deepEqual(selections, [['claude', { model: 'opus', effort: 'high', fast: false }]]);
});

test('a target still loading its models says so; no other usable harness offers no Continue', async () => {
  models = {};
  await show(h(HarnessDownNotice, { threadId: 'c', family: 'codex' }));
  await click($$('.elsewhere-actions button')[1]);
  assert.deepEqual(toasts.at(-1), ['Claude Code is still loading its models']);
  assert.equal($('.sheet'), null);
  store.setState({ usable: [] });
  await show(h(HarnessDownNotice, { threadId: 'c', family: 'codex' }));
  assert.deepEqual(
    $$('.elsewhere-actions button').map((b) => b.textContent),
    ['Restart Codex'],
  );
});

test('a switch picked to the harness that is down: the notice shows, and continuing where the chat is drops the switch', async () => {
  store.setState({ codexDown: true, segments: { c: seg('claude') } });
  session = { pendingSwitch: { harness: 'codex', model: 'gpt' } };
  await area();
  assert.match($('.elsewhere-notice').textContent!, /Codex isn't running/);
  await click($$('.elsewhere-actions button')[1]);
  assert.deepEqual(cleared, ['c']);
  assert.equal($('.sheet'), null);
  // a switch picked away from it: the next message goes to a harness that runs, so the composer is back
  store.setState({ segments: { c: seg('codex') } });
  session = { pendingSwitch: { harness: 'claude', model: 'opus' } };
  await area();
  assert.ok($('.composer'));
});

test("a harness with no restart, named by the chat's own label when it is a basic one", async () => {
  store.setState({ usable: ['claude', 'codex'] });
  await show(h(HarnessDownNotice, { threadId: 'acp:kimi:1', family: 'acp' }));
  assert.match($('.elsewhere-notice').textContent!, /label of acp:kimi:1 isn't running/);
  // a basic chat has no first-tier harness to switch from in place: no Continue
  assert.equal($$('.elsewhere-actions button').length, 0);
});

test('the harness that is down is named by its own label, and a target with Fast keeps it', async () => {
  store.setState({ codexDown: false, claudeDown: true, usable: ['codex'], segments: { c: seg('claude') } });
  await area();
  assert.match($('.elsewhere-notice').textContent!, /Claude Code isn't running/);
  // no restart for it: only Continue
  assert.deepEqual(
    $$('.elsewhere-actions button').map((b) => b.textContent),
    ['Continue in Codex'],
  );
  await click($('.elsewhere-actions button'));
  await click($('.ok'));
  assert.deepEqual(selections, [['codex', { model: 'gpt', effort: 'high' }]]);
});

test("the agent's waiting questions dock above the composer, which stays; an approval or a down harness comes first", async () => {
  store.setState({ codexDown: false });
  const question = { type: 'agentMessage', id: 'q1', questions: [{ title: 'Which?', options: null }] };
  await area({ question });
  assert.equal($('.docked').textContent, 'q1');
  assert.ok($('.composer'));
  assert.equal($('.docked').compareDocumentPosition($('.composer')) & Node.DOCUMENT_POSITION_FOLLOWING, Node.DOCUMENT_POSITION_FOLLOWING);
  await area({ question, hasApproval: true });
  assert.equal($('.docked'), null);
  assert.ok($('.approvals'));
  store.setState({ codexDown: true });
  await area({ question });
  assert.equal($('.docked'), null);
  assert.ok($('.elsewhere-notice'));
  // no composer here (a read-only view): nothing docks
  store.setState({ codexDown: false });
  await area({ question, composer: false });
  assert.equal($('.docked'), null);
});

test('a MoMo chat offers its brain chip instead of a switch: only MoMo’s brain moves it to another harness', async () => {
  const { MomoModelSlot } = await import('../src/components/momo/useMomoChat.ts');
  store.setState({ momoChats: { c: 'main' } });
  const chip = h('button', { className: 'stub-brain' }, 'brain');
  await show(h(MomoModelSlot.Provider, { value: chip }, h(HarnessDownNotice, { threadId: 'c', family: 'codex' } as any)));
  assert.ok($('.elsewhere-actions .stub-brain'));
  assert.deepEqual(
    $$('.elsewhere-actions .btn-pill').map((b) => b.textContent),
    ['Restart Codex'],
  );
  // a coding chat on the same harness keeps its ways on
  store.setState({ momoChats: {} });
  await show(h(MomoModelSlot.Provider, { value: chip }, h(HarnessDownNotice, { threadId: 'c', family: 'codex' } as any)));
  assert.ok(!$('.stub-brain'));
  assert.ok($$('.elsewhere-actions .btn-pill').some((b) => b.textContent === 'Continue in Claude Code'));
});
