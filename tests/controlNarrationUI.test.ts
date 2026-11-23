// The thread's browser/desktop control narration (src/components/thread/Items.tsx) and the title bar's
// agent tab badges (src/components/titleBar/TitleBar.tsx), PR #352: rendered for real with happy-dom; the rest of
// each component's imports are stubbed.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
// Side-effect import: installs the happy-dom globals (a named, unused import gets stripped by lint fixes).
import './support/dom.ts';
import * as react from 'react';
import { controlNarrationFixture } from './support/control-narration-kit.ts';

(globalThis as any).requestAnimationFrame = (fn: Function) => {
  fn();
  return 1;
};

const fixture = await controlNarrationFixture();
const { act, createElement } = react;
const { createRoot } = await import('react-dom/client');
const { StepGroup } = await import('../src/components/thread/Items.tsx');
const { summarizeSteps } = await import('../src/components/thread/items/stepModel.ts');
const { activeStepLabel } = await import('../src/components/thread/items/presentation.tsx');
const { StepRow } = await import('../src/components/thread/items/StepRow.tsx');
const { TitleBar } = await import('../src/components/titleBar/TitleBar.tsx');
const { StatusSlot } = await import('../src/components/thread/statusSlot.tsx');

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement;
async function render(el: any) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(el));
  return container;
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
});

const PNG = (n: string) => `data:image/png;base64,${n}`;
const call = (tool: string, args: any = {}, o: any = {}) => ({
  id: `${tool}-${Math.random()}`,
  type: o.type ?? 'mcpToolCall',
  server: o.server,
  tool,
  arguments: args,
  status: o.status ?? 'completed',
  durationMs: o.durationMs,
  result: {
    content: [
      ...(o.text ? [{ type: 'text', text: o.text }] : []),
      ...(o.shots ?? []).map((s: string) => ({ type: 'image', data: s, mimeType: 'image/png' })),
    ],
  },
});
const step = (item: any) => ({ kind: 'tool', item });

/* ---------- Items.tsx ---------- */

test('summarizeSteps: browser and desktop control read as what they did, other tools stay tool calls', () => {
  const browse = step(call('mcp__sage_0123456789ab__browser_navigate', { url: 'https://a.test' }));
  const desk = step(call('desktop_left_click', {}, { type: 'dynamicToolCall' }));
  const other = step(call('sage_debug_echo'));
  // Claude Desktop's words: equal actions merge with a count
  assert.deepEqual(summarizeSteps([browse as any, browse as any]), { text: 'Opened 2 times', icon: 'web' });
  assert.deepEqual(summarizeSteps([desk as any]), { text: 'Clicked', icon: 'tool' });
  assert.deepEqual(summarizeSteps([other as any]), { text: 'Called a tool', icon: 'tool' });
  assert.deepEqual(summarizeSteps([browse as any, desk as any, other as any, other as any]), {
    text: 'Opened, clicked, called 2 tools',
    icon: 'web',
  });
  // non-tool steps are not counted as control
  assert.equal(summarizeSteps([{ kind: 'web', item: { query: 'x' } as any }, browse as any]).text, 'Searched the web, opened');
});

test('activeStepLabel: a running control call says what it is doing; other tools are named', () => {
  assert.equal(activeStepLabel(step(call('browser_find', { query: 'Pricing' })) as any), 'Looking for “Pricing”');
  assert.equal(activeStepLabel(step(call('desktop_type', { text: 'hello' })) as any), 'Typing 5 characters');
  assert.equal(activeStepLabel(step(call('sage_debug_echo')) as any), 'Calling sage_debug_echo');
});

test('StepRow: a control call shows its narration, the screenshot thumbnail and the matching icon', async () => {
  const el = await render(
    createElement(
      'div',
      null,
      createElement(StepRow, {
        step: step(
          call('browser_computer', { action: 'left_click', ref: 'ref_4' }, { text: 'on ref_4 "Buy"', shots: ['one', 'two'] }),
        ) as any,
        cwd: '/w',
      }),
      createElement(StepRow, { step: step(call('desktop_type', { text: 'abc' }, { text: '{"app":"Notes"}' })) as any, cwd: '/w' }),
      createElement(StepRow, { step: step(call('sage_debug_echo', {}, { server: 'sage', durationMs: 1200 })) as any, cwd: '/w' }),
      createElement(StepRow, { step: step(call('sage_debug_echo')) as any, cwd: '/w' }),
      createElement(StepRow, { step: { kind: 'read', item: { status: 'completed' } as any, path: 'a.ts' }, cwd: '/w' }),
    ),
  );
  const rows = [...el.querySelectorAll('.step-row')];
  assert.equal(rows[0].querySelector('.step-text')!.textContent, 'Clicked “Buy”');
  assert.equal(rows[0].querySelector<HTMLImageElement>('.step-thumb')!.getAttribute('src'), PNG('two'));
  // the screenshot sits at the row's end, after the chevron, as Claude Desktop places it
  assert.equal(rows[0].lastElementChild!.className, 'step-thumbs');
  assert.equal(rows[0].lastElementChild!.previousElementSibling!.getAttribute('data-icon'), 'ChevronDown');
  assert.equal(rows[0].querySelector('[data-icon]')!.getAttribute('data-icon'), 'Globe');
  assert.equal(rows[1].querySelector('.step-text')!.textContent, 'Typed 3 characters in Notes');
  assert.equal(rows[1].querySelector('.step-thumb') === null, true);
  assert.equal(rows[1].querySelector('[data-icon]')!.getAttribute('data-icon'), 'MousePointerClick');
  // MoPilot's own server is left out of the name (#2280)
  assert.match(rows[2].querySelector('.step-text')!.textContent!, /^Called sage_debug_echo · /);
  assert.equal(rows[2].querySelector('[data-icon]')!.getAttribute('data-icon'), 'Plug');
  assert.equal(rows[3].querySelector('.step-text')!.textContent, 'Called sage_debug_echo');
  assert.equal(rows[4].querySelector('[data-icon]')!.getAttribute('data-icon'), 'BookOpen');
  // expanding a control row shows the call's input and output
  await act(async () => rows[0].querySelector<HTMLElement>('.step-row-hit, button.step-row')!.click());
  assert.ok(el.querySelector('.tool-screenshot'));
});

test('StepGroup: a collapsed group of control calls shows its last screenshots at its end; a group without one shows none', async () => {
  fixture.state = { prefs: { showReasoning: true } };
  const shotThenNot = [
    call('browser_navigate', { url: 'https://a.test' }, { shots: ['old'] }),
    call('browser_computer', { action: 'screenshot' }, { shots: ['new'] }),
    call('desktop_type', { text: 'x' }),
    call('sage_debug_echo', {}, { shots: ['not-control'] }),
  ];
  let el = await render(createElement(StepGroup, { items: shotThenNot, cwd: '/w', active: false }));
  const summary = el.querySelector('.step-row.summary')!;
  assert.equal(summary.querySelector('.step-text')!.textContent, 'Opened, captured page, typed, called a tool');
  // the newest control screenshots, oldest first at the row's end (after the chevron), not an ordinary tool's image
  const thumbs = [...summary.querySelectorAll('.step-thumbs > .step-thumb')].map((i) => i.getAttribute('src'));
  assert.deepEqual(thumbs, [PNG('old'), PNG('new')]);
  assert.equal(summary.querySelector('.step-text .step-thumb'), null);
  assert.equal(summary.lastElementChild!.className, 'step-thumbs');
  await act(async () => root!.unmount());
  root = null;
  container.remove();
  el = await render(
    createElement(StepGroup, {
      items: [
        call('desktop_type', { text: 'x' }),
        { id: 'r', type: 'commandExecution', command: 'ls', status: 'completed', commandActions: [] } as any,
      ],
      cwd: '/w',
      active: false,
    }),
  );
  assert.equal(el.querySelector('.step-row.summary .step-thumb') === null, true);
});

test('StepGroup: a control step Stop cut off is not counted as failed', async () => {
  fixture.state = { prefs: { showReasoning: true } };
  const items = [
    call('browser_navigate', { url: 'https://a.test' }, { text: 'ok' }),
    { ...call('browser_computer', { action: 'left_click', ref: 'ref_1' }, { status: 'failed', text: '' }), cutOff: true },
  ];
  const el = await render(createElement(StepGroup, { items, cwd: '/w', active: false }));
  assert.equal(el.querySelector('.control-run > .step-row.summary .step-text')!.textContent, 'Opened, clicked');
});

test('StepGroup: a browser failure the turn got past reads "Retried another way", not failed; the error stays in its details', async () => {
  fixture.state = { prefs: { showReasoning: true } };
  const refused = 'ref_9 is stale or not found on the current page.';
  const items = [
    call('browser_computer', { action: 'left_click', ref: 'ref_9' }, { status: 'failed', text: refused }),
    call('browser_computer', { action: 'left_click', ref: 'ref_10' }, { text: 'on ref_10 "Buy"' }),
    call('browser_navigate', { url: 'https://a.test' }, { status: 'failed', text: 'The user did not allow https://a.test.' }),
  ];
  const el = await render(createElement(StepGroup, { items, cwd: '/w', active: false }));
  const summary = el.querySelector('.control-run > .step-row.summary')!;
  // only the failure nothing came after counts
  assert.equal(summary.querySelector('.step-text')!.textContent, 'Clicked 2 times, opened (1 failed)');
  await act(async () => summary.querySelector<HTMLElement>('.step-row-hit')!.click());
  const rows = [...el.querySelectorAll('.step-list > .step')];
  assert.deepEqual(
    rows.map((r) => [r.className.trim().split(/\s+/).slice(1).join(' '), r.querySelector('.step-text')!.textContent]),
    [
      ['recovered', 'Clicked an element · Retried another way'],
      ['', 'Clicked “Buy”'],
      ['failed', 'Opened a.test'],
    ],
  );
  // collapsed by default; the raw error is one click away
  assert.equal(rows[0].querySelector('.step-body'), null);
  await act(async () => rows[0].querySelector<HTMLElement>('.step-row-hit, button.step-row')!.click());
  assert.match(rows[0].textContent!, /ref_9 is stale or not found/);
});

test('StepGroup (Claude dots UX): the running control call is narrated; otherwise the harness label stays', async () => {
  fixture.state = { prefs: { showReasoning: true } };
  const running = call('desktop_open_application', { app: 'Calendar' }, { status: 'inProgress' });
  let el = await render(createElement(StepGroup, { items: [call('browser_tabs_context'), running], cwd: '/w', active: true, ux: 'dots' }));
  assert.equal(el.querySelector('.claude-activity')!.textContent, 'Opening Calendar');
  await act(async () => root!.unmount());
  root = null;
  container.remove();
  // a running tool that is not control: the generic label
  el = await render(
    createElement(StepGroup, { items: [call('sage_debug_echo', {}, { status: 'inProgress' })], cwd: '/w', active: true, ux: 'dots' }),
  );
  assert.notEqual(el.querySelector('.claude-activity')!.textContent, '');
  assert.doesNotMatch(el.querySelector('.claude-activity')!.textContent!, /Opening|Clicking/);
  await act(async () => root!.unmount());
  root = null;
  container.remove();
  // the last call finished (between steps): the row keeps its words, as Claude Desktop's does
  el = await render(
    createElement(StepGroup, { items: [call('desktop_open_application', { app: 'Calendar' })], cwd: '/w', active: true, ux: 'dots' }),
  );
  assert.equal(el.querySelector('.claude-activity')!.textContent, 'Opening Calendar');
  await act(async () => root!.unmount());
  root = null;
  container.remove();
  // a running non-tool step
  el = await render(
    createElement(StepGroup, {
      items: [{ id: 'w', type: 'webSearch', query: 'q', status: 'inProgress' as any } as any],
      cwd: '/w',
      active: true,
      ux: 'dots',
    }),
  );
  assert.ok(el.querySelector('.claude-activity'));
  await act(async () => root!.unmount());
  root = null;
  container.remove();
  // the shimmer UX narrates through activeStepLabel
  el = await render(createElement(StepGroup, { items: [running], cwd: '/w', active: true }));
  assert.equal(el.querySelector('.shimmer')!.textContent, 'Opening Calendar');
  await act(async () => root!.unmount());
  root = null;
  container.remove();
  // In a thread the group moves its single narrated line below the task list.
  const slot = document.body.appendChild(document.createElement('div'));
  const group = createElement(StepGroup, { items: [call('browser_tabs_context'), running], cwd: '/w', active: true, ux: 'dots' });
  el = await render(createElement(StatusSlot.Provider, { value: slot }, group));
  assert.equal(el.querySelector('.claude-activity'), null);
  assert.equal(slot.querySelector('.claude-activity')!.textContent, 'Opening Calendar');
  slot.remove();
});

/* ---------- TitleBar.tsx ---------- */

const agentView = (patch: any = {}) => ({
  tabId: 'tab_1',
  tabKey: null,
  kind: 'tab',
  active: true,
  created: false,
  mark: null,
  takenOver: false,
  origin: null,
  access: null,
  ...patch,
});
function titleState(paneTabs: any[], agentTabs: any, patch: any = {}) {
  fixture.calls = [];
  fixture.state = {
    route: { name: 'home' },
    back: [],
    forward: [],
    sidebarOpen: true,
    summaryOpen: false,
    shellFit: { sidebar: true, summary: true },
    shellForced: {},
    bottomPanelOpen: false,
    segments: {},
    chatConfig: {},
    paneTabs,
    paneActive: paneTabs[0]?.id ?? null,
    agentTabs,
    paneFull: false,
    prefs: { bottomPanelControl: false },
    fullscreen: false,
    threads: {},
    pinned: {},
    savedProjects: [],
    diffPanel: { open: true },
    paneWidth: 600,
    ...patch,
  };
}
const tabEl = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll<HTMLElement>('.tb-tab')].find((t) => t.querySelector('span')!.textContent === label)!;

test('TitleBar: tabs an agent opened, kept or is driving carry a badge and the active state, from any harness', async () => {
  titleState(
    [
      { id: 'p1', kind: 'browser', url: 'https://a.test/', title: 'Driving', agentChat: 'chat-a' },
      { id: 'p2', kind: 'browser', url: 'https://b.test/', title: 'Opened', agentChat: 'chat-a', agentTab: 'tab_2' },
      { id: 'p3', kind: 'browser', url: 'https://c.test/', title: 'Handoff', agentChat: 'chat-b', agentTab: 'tab_3' },
      { id: 'p4', kind: 'browser', url: 'https://d.test/', title: 'Taken', agentChat: 'chat-c' },
      { id: 'p5', kind: 'browser', url: '', title: '', agentChat: 'chat-gone' },
      { id: 'p6', kind: 'browser', url: 'https://e.test/', title: 'Mine' },
    ],
    {
      'chat-a': [agentView(), agentView({ tabKey: 'tab_2', tabId: 'tab_2', created: true, active: false })],
      'chat-b': [agentView({ tabKey: 'tab_3', tabId: 'tab_3', mark: 'handoff', active: false })],
      'chat-c': [agentView({ takenOver: true, mark: 'deliverable' })],
      // the chat on screen, its other harness sessions mapped to it
    },
    { route: { name: 'thread', id: 'chat-a' }, alias: { 'chat-b': 'chat-a', 'chat-c': 'chat-a', 'chat-gone': 'chat-a' } },
  );
  const el = await render(createElement(TitleBar));
  const driving = tabEl(el, 'Driving');
  assert.match(driving.className, /\bagent-active\b/);
  assert.equal(driving.title, 'https://a.test/');
  assert.equal(driving.querySelector('[data-icon]')!.getAttribute('data-icon'), 'Globe');
  const opened = tabEl(el, 'Opened');
  assert.doesNotMatch(opened.className, /agent-active/);
  assert.equal(opened.title, 'Opened by the agent (closes when its turn ends)\nhttps://b.test/');
  assert.equal(opened.querySelector('[data-icon]')!.getAttribute('data-icon'), 'Bot');
  assert.equal(opened.querySelector('[data-icon]')!.getAttribute('aria-label'), 'Opened by the agent (closes when its turn ends)');
  assert.match(tabEl(el, 'Handoff').title, /^Opened by the agent for you to continue/);
  // taken over: not shown as the agent's, but its kept-for-you badge stays
  const taken = tabEl(el, 'Taken');
  assert.doesNotMatch(taken.className, /agent-active/);
  assert.match(taken.title, /^Opened by the agent to show you a result/);
  // no view, no url: no title at all
  const blank = tabEl(el, 'New tab');
  assert.equal(blank.hasAttribute('title'), false);
  assert.equal(tabEl(el, 'Mine').title, 'https://e.test/');
  // clicking a tab activates it; its close button closes only it
  await act(async () => tabEl(el, 'Opened').click());
  assert.equal(fixture.state.paneActive, 'p2');
  assert.match(tabEl(el, 'Opened').className, /\bactive\b/);
  await act(async () => tabEl(el, 'Mine').querySelector<HTMLElement>('.tb-tab-close')!.click());
  assert.deepEqual(fixture.calls.at(-1), ['closePaneTab', 'p6']);
  assert.equal(fixture.state.paneActive, 'p2');
  // main pushes a new snapshot: the strip follows
  await act(async () => fixture.update({ agentTabs: {} }));
  assert.doesNotMatch(tabEl(el, 'Driving').className, /agent-active/);
  assert.equal(tabEl(el, 'Opened').querySelector('[data-icon]')!.getAttribute('data-icon'), 'Globe');
});

test('TitleBar: tabs of other kinds keep their icons and labels and never show agent state', async () => {
  titleState(
    [
      { id: 'c', kind: 'changes', agentChat: 'chat-a' },
      { id: 'f', kind: 'files' },
      { id: 'fi', kind: 'file', title: 'a.ts' },
      { id: 's', kind: 'skill', title: 'Skill' },
      { id: 't', kind: 'terminal', title: 'zsh' },
      { id: 'sc', kind: 'chat' },
      { id: 'sub', kind: 'chat', readOnly: true },
      { id: 'sub2', kind: 'chat', readOnly: true, title: 'Explorer' },
    ],
    { 'chat-a': [agentView({ created: true })] },
  );
  const el = await render(createElement(TitleBar));
  const tabs = [...el.querySelectorAll<HTMLElement>('.tb-tab')];
  assert.deepEqual(
    tabs.map((t) => [
      t.querySelector('span')!.textContent,
      t.querySelector('[data-icon]')!.getAttribute('data-icon'),
      t.hasAttribute('title'),
      /agent-active/.test(t.className),
    ]),
    [
      ['Changes', 'DiffSquare', false, false],
      ['Files', 'FolderTree', false, false],
      ['a.ts', 'FileText', false, false],
      ['Skill', 'Box', false, false],
      ['zsh', 'SquareTerminal', false, false],
      ['Side chat', 'SideChatIcon', false, false],
      ['Sub-agent', 'SideChatIcon', false, false],
      ['Explorer', 'SideChatIcon', false, false],
    ],
  );
});

test("TitleBar: a chat's view lists only its own agent tabs; another chat's never show, and the front tab falls back to one in view", async () => {
  titleState(
    [
      { id: 'mine', kind: 'browser', url: 'https://a.test/', title: 'Mine', agentChat: 'chat-a', agentTab: 'tab_1' },
      { id: 'theirs', kind: 'browser', url: 'https://b.test/', title: 'Theirs', agentChat: 'chat-b', agentTab: 'tab_2' },
      { id: 'user', kind: 'browser', url: 'https://c.test/', title: 'User tab' },
      { id: 'side', kind: 'chat', threadId: 'side-1' },
      { id: 'side-tab', kind: 'browser', url: 'https://d.test/', title: 'Side tab', agentChat: 'side-1' },
    ],
    { 'chat-b': [agentView({ tabKey: 'tab_2', tabId: 'tab_2' })] },
    { route: { name: 'thread', id: 'chat-a' }, paneActive: 'theirs' },
  );
  const el = await render(createElement(TitleBar));
  const labels = () => [...el.querySelectorAll<HTMLElement>('.tb-tab')].map((t) => t.querySelector('span')!.textContent);
  assert.deepEqual(labels(), ['Mine', 'User tab', 'Side chat', 'Side tab']);
  assert.match(tabEl(el, 'Side tab').className, /\bactive\b/, "the pane's active tab is chat-b's: the last tab in view is in front");
  // chat-b on screen: its tab shows, chat-a's doesn't
  await act(async () => fixture.update({ route: { name: 'thread', id: 'chat-b' } }));
  assert.deepEqual(labels(), ['Theirs', 'User tab', 'Side chat', 'Side tab']);
  assert.match(tabEl(el, 'Theirs').className, /\bactive\b/);
  // a page with no chat shows no agent tabs
  await act(async () =>
    fixture.update({ route: { name: 'home' }, paneTabs: fixture.state.paneTabs.filter((t: any) => t.kind !== 'chat') }),
  );
  assert.deepEqual(labels(), ['User tab']);
  assert.match(tabEl(el, 'User tab').className, /\bactive\b/);
  await act(async () => fixture.update({ paneTabs: fixture.state.paneTabs.filter((t: any) => t.id !== 'user') }));
  assert.deepEqual(labels(), []);
});

test('StepGroup: a collapsed run shows its last three screenshots after a count of the earlier ones (one when narrow)', async () => {
  fixture.state = { prefs: { showReasoning: true } };
  const items = ['a', 'b', 'c', 'd', 'e'].map((n) => call('browser_computer', { action: 'screenshot' }, { shots: [n] }));
  const el = await render(createElement(StepGroup, { items, cwd: '/w', active: false }));
  const summary = el.querySelector('.step-row.summary')!;
  assert.equal(summary.querySelector('.step-text')!.textContent, 'Captured page 5 times');
  const thumbs = [...summary.querySelectorAll('.step-thumbs > .step-thumb')];
  assert.deepEqual(
    thumbs.map((i) => i.getAttribute('src')),
    [PNG('c'), PNG('d'), PNG('e')],
  );
  assert.deepEqual(
    thumbs.map((i) => i.classList.contains('step-thumb-wide')),
    [true, true, false],
  );
  assert.equal(summary.querySelector('.step-thumbs-more.wide')!.textContent, '+2');
  assert.equal(summary.querySelector('.step-thumbs-more.narrow')!.textContent, '+4');
  assert.equal(thumbs[0].getAttribute('alt'), 'Screenshot 3');
});

test('StepGroup: a lone control call shows its screenshots below it once the turn moved on; a running one keeps a thumbnail', async () => {
  fixture.state = { prefs: { showReasoning: true } };
  const batch = call(
    'browser_batch',
    {
      actions: [
        { name: 'computer', input: { action: 'left_click' } },
        { name: 'computer', input: { action: 'screenshot' } },
      ],
    },
    { shots: ['one', 'two'] },
  );
  let el = await render(createElement(StepGroup, { items: [batch], cwd: '/w', active: false }));
  assert.equal(el.querySelector('.step-text')!.textContent, 'Clicked, captured page in 2 steps');
  const shots = el.querySelector('.step-shots.several')!;
  assert.deepEqual(
    [...shots.querySelectorAll('.step-shot')].map((i) => [i.getAttribute('src'), i.getAttribute('alt')]),
    [
      [PNG('one'), 'Screenshot 1'],
      [PNG('two'), 'Screenshot 2'],
    ],
  );
  assert.equal(el.querySelector('.step-thumb'), null);
  // opened, its details don't draw the same screenshots again
  await act(async () => el.querySelector<HTMLElement>('.step-row-hit')!.click());
  assert.equal(el.querySelectorAll('.step-shot').length, 2);
  assert.equal(el.querySelector('.tool-screenshot'), null);
  await act(async () => root!.unmount());
  root = null;
  container.remove();
  // one screenshot is not "several"
  el = await render(
    createElement(StepGroup, { items: [call('browser_computer', { action: 'screenshot' }, { shots: ['x'] })], cwd: '/w', active: false }),
  );
  assert.ok(el.querySelector('.step-shots:not(.several) > .step-shot'));
  await act(async () => root!.unmount());
  root = null;
  container.remove();
  // still the turn's latest work: a thumbnail at the row's end, as Claude Desktop holds the latest row's images
  el = await render(createElement(StepGroup, { items: [batch], cwd: '/w', active: true }));
  assert.equal(el.querySelector('.step-shots'), null);
  assert.equal(el.querySelector('.step-thumb')!.getAttribute('src'), PNG('two'));
});

test('summarizeSteps: a group with control folds past four phrases and names no thinking', () => {
  const s = (tool: string, args: any = {}, o: any = {}) => step(call(tool, args, o));
  const steps = [
    { kind: 'web', item: { query: 'x' } },
    s('browser_navigate', { url: 'https://a.test' }),
    s('browser_computer', { action: 'left_click' }),
    s('browser_computer', { action: 'type', text: 'x' }),
    s('browser_find', { query: 'y' }, { status: 'failed' }),
    { kind: 'reasoning', item: { id: 'r', type: 'reasoning', summary: ['x'], content: [] } },
  ];
  assert.deepEqual(summarizeSteps(steps as any), { text: 'Searched the web, opened, clicked, and 2 more actions, 1 failed', icon: 'web' });
});

test('controlStep: an app batch row says its actions, its steps and its app', async () => {
  const { controlStep } = await import('../src/lib/agentNarration.ts');
  const item = call('desktop_app_batch', { app: 'Notes', actions: [{ action: 'click' }, { action: 'type', text: 'hi' }] });
  assert.equal(controlStep(item)!.done, 'Clicked, typed in 2 steps in Notes');
  assert.equal(controlStep(item)!.doing, 'Clicking, typing in 2 steps in Notes');
});

test('controlStepVerb: a program or an unknown tool keeps its own words; a batch ending on an unknown action keeps its verbs', async () => {
  const { controlStep, controlStepVerb } = await import('../src/lib/agentNarration.ts');
  const script = call('browser_script', { code: "await tab.goto('https://a.test')" });
  const own = controlStepVerb(script, controlStep(script)!);
  assert.deepEqual([own.done, own.unknown], [controlStep(script)!.done, true]);
  const batch = call('browser_batch', { actions: [{ name: 'find' }, { name: 'new_tool' }] });
  assert.equal(controlStepVerb(batch, controlStep(batch)!).done, 'Found, used the browser');
  assert.equal(controlStep(batch)!.done, 'Found, used the browser in 2 steps');
});
