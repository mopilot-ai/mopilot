// The agent page (src/components/agents/AgentPage.tsx): the model line, the folding prompt bubble, the agent's
// transcript through the main transcript's renderer, the spark while running, the report and stats once settled,
// summary-only harnesses, and the loading, empty and error states.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { scrollObserver } from './support/scroll-observer.ts';
import {
  mockStore,
  autoMock,
  stubComponent,
  render,
  settle,
  resetStore,
  setStore,
  callsTo,
  moduleCalls,
  window,
} from './support/thread-kit.ts';

mockStore();
autoMock('src/store/panes.ts', 'panes');
autoMock('src/components/markdown/Markdown.tsx', 'md', { Markdown: stubComponent('Markdown'), CodeBlock: stubComponent('CodeBlock') });
autoMock('src/components/ui/Presence.tsx', 'presence', {
  Collapse: ({ open, children }: any) => (open ? h('div', { className: 'collapse open' }, children) : null),
});
const { AgentPage } = await import('../src/components/agents/AgentPage.tsx');
const { FOLD_CLAMP_PX } = await import('../src/components/ui/FoldedText.tsx');
const T = await import('../src/store/agentThreads.ts');

// the bubble's text measures tall when it holds a long prompt (happy-dom does no layout)
Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', {
  configurable: true,
  get(this: HTMLElement) {
    return this.classList.contains('fold-text') && (this.textContent ?? '').length > 100 ? FOLD_CLAMP_PX + 1 : 0;
  },
});

// each test's agent transcripts are its own chat's, so none carries over
let chats = 0;
let CHAT = '';
beforeEach(() => {
  resetStore();
  moduleCalls.length = 0;
  CHAT = `chat-${++chats}`;
  T.setAgentThreadLoaderResolver(() => null);
});

const run = (key: string, extra: any = {}) => ({
  key,
  description: `Track ${key}: fix things`,
  prompt: 'Fix the parser',
  model: 'Opus 5.5',
  background: false,
  status: 'running',
  toolUses: 3,
  latestTool: null,
  tokens: 165_432,
  startedAt: 1000,
  completedAt: 124_000,
  report: null,
  transcript: 'full',
  ...extra,
});
const withRuns = (...runs: any[]) =>
  setStore({
    runtime: { [CHAT]: { turns: [{ id: 't1', items: runs.map((r) => ({ id: `i-${r.key}`, type: 'dynamicToolCall', agent: r })) }] } },
  });
const page = (agentKey = 'A') => h(AgentPage, { chatId: CHAT, agentKey, cwd: '/repo' });
const text = (el: Element | null) => el?.textContent ?? null;

test('an agent the chat does not know yet shows Loading', async () => {
  const v = await render(page('nope'));
  assert.equal(text(v.$('.agent-page-placeholder')), 'Loading…');
  assert.equal(v.$('.agent-page')!.dataset.agent, 'nope');
  await v.unmount();
});

test('a running agent: model line, folding prompt, no activity yet, then its transcript and the spark', async () => {
  withRuns(run('A', { prompt: 'Long prompt '.repeat(20) }));
  const v = await render(page());
  assert.equal(text(v.$('.agent-page-model')), 'Model Opus 5.5');
  assert.equal(text(v.$('.agent-page-model-value')), 'Opus 5.5');
  const body = v.$('.fold-text')!;
  assert.match(body.className, /clamped/);
  await settle(() => v.$('.fold-more')!.click());
  assert.doesNotMatch(body.className, /clamped/);
  assert.equal(text(v.$('.fold-more')), 'Show less');
  await settle(() => v.$('.fold-more')!.click());
  assert.equal(text(v.$('.fold-more')), 'Show more');
  assert.equal(text(v.$('.agent-page-placeholder')), 'No activity yet');
  assert.equal(text(v.$('.agent-spark[role="status"]')), 'Thinking…');
  assert.equal(v.$('.agent-page-stats'), null);

  // the session streams the agent's items: rendered as the main transcript renders them
  await settle(() =>
    T.putAgentItems(CHAT, 'A', [
      { id: 'm1', type: 'agentMessage', text: 'Looking at the parser' },
      { id: 'c1', type: 'commandExecution', command: 'npm test', status: 'completed', commandActions: [] },
      { id: 'n1', type: 'dynamicToolCall', agent: run('A.1', { description: 'Check the lexer', status: 'completed' }) },
    ] as any),
  );
  assert.equal(v.$('.agent-page-placeholder'), null);
  assert.equal(v.$('.agent-page-entries .commentary [data-stub="Markdown"]')!.dataset.text, 'Looking at the parser');
  // a nested agent is an agent group whose row opens its own page in the same chat
  const head = v.$('.agent-page-entries .agent-group-head')!;
  await settle(() => head.click());
  await settle(() => v.$('.agent-row')!.click());
  assert.deepEqual(callsTo('panes:openAgentPage'), [[CHAT, 'A.1', 'Check the lexer']]);
  // scrolling records whether the page follows the newest step, and marks it, so the browser's scroll anchoring
  // does not move it off the bottom while it follows
  const scroller = v.$('.agent-page')!;
  await settle(() => scroller.dispatchEvent(new window.Event('scroll') as any));
  assert.ok(scroller.classList.contains('following'));
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 300 });
  scroller.scrollTop = 700;
  await settle(() => scroller.dispatchEvent(new window.Event('scroll') as any));
  scroller.scrollTop = 300;
  await settle(() => scroller.dispatchEvent(new window.Event('scroll') as any));
  assert.equal(scroller.classList.contains('following'), false);
  assert.ok(v.$('.agent-spark'));
  await v.unmount();
});

test('a nested agent opens from its parent agent’s transcript; a short prompt does not fold', async () => {
  withRuns(run('A'));
  T.putAgentItems(CHAT, 'A', [
    { id: 'n1', type: 'dynamicToolCall', agent: run('A.1', { prompt: 'Check', model: null, status: 'completed', report: 'Lexer ok' }) },
  ] as any);
  const v = await render(page('A.1'));
  assert.equal(v.$('.agent-page-model'), null);
  assert.equal(text(v.$('.fold-text')), 'Check');
  assert.equal(v.$('.fold-more'), null);
  assert.equal(v.$('.agent-page-report [data-stub="Markdown"]')!.dataset.text, 'Lexer ok');
  assert.equal(text(v.$('.agent-page-stats')), '3 tool calls · 165.4k tokens · 2m 3s');
  assert.equal(v.$('.agent-spark'), null);
  await v.unmount();
});

test('agent transcripts retain follow intent through layout and nonmoving input, and yield to upward scrolling', async (t) => {
  const observer = scrollObserver(t);
  withRuns(run('A'));
  const v = await render(page());
  const scroll = v.$('.agent-page')!;
  const size = { scrollHeight: 1000, clientHeight: 300 };
  for (const key of ['scrollHeight', 'clientHeight'] as const)
    Object.defineProperty(scroll, key, { configurable: true, get: () => size[key] });
  const scrolled = () => settle(() => scroll.dispatchEvent(new window.Event('scroll') as any));
  scroll.scrollTop = 700;
  await scrolled();
  for (const event of [
    new window.WheelEvent('wheel', { deltaY: 50, bubbles: true }),
    new window.WheelEvent('wheel', { deltaX: 50, bubbles: true }),
    new window.KeyboardEvent('keydown', { key: 'End', bubbles: true }),
    new window.KeyboardEvent('keydown', { key: 'a', bubbles: true }),
  ])
    await settle(() => scroll.dispatchEvent(event as any));
  size.clientHeight = 200;
  await scrolled();
  observer.notify(scroll);
  observer.paint();
  assert.equal(scroll.scrollTop, 1000, 'the viewport is watched even without more content');
  await scrolled();
  await settle(() => scroll.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -20, bubbles: true }) as any));
  scroll.scrollTop = 780;
  await scrolled();
  assert.equal(scroll.classList.contains('following'), false);
  size.scrollHeight = 1200;
  observer.notify(scroll);
  observer.paint();
  assert.equal(scroll.scrollTop, 780);
  scroll.scrollTop = 1000;
  await scrolled();
  assert.equal(scroll.classList.contains('following'), true);
  await settle(() => scroll.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }) as any));
  assert.equal(scroll.classList.contains('following'), false);
  await v.unmount();
  assert.equal(observer.watching, 0);
});

test('switching between running agents and chats starts a fresh viewport follow owner', async (t) => {
  const observer = scrollObserver(t);
  withRuns(run('A'), run('B'));
  const v = await render(page());
  const a = v.$('.agent-page')!;
  Object.defineProperty(a, 'scrollHeight', { configurable: true, value: 1000 });
  a.scrollTop = 700;
  await settle(() => a.dispatchEvent(new window.Event('scroll') as any));
  a.scrollTop = 300;
  await settle(() => a.dispatchEvent(new window.Event('scroll') as any));
  assert.equal(a.classList.contains('following'), false);
  await v.rerender(page('B'));
  const b = v.$('.agent-page')!;
  assert.equal(a === b, false);
  assert.equal(b.classList.contains('following'), true);
  await settle(() => setStore((s: any) => ({ runtime: { ...s.runtime, other: s.runtime[CHAT] } })));
  await v.rerender(h(AgentPage, { chatId: 'other', agentKey: 'B', cwd: '/repo' }));
  assert.equal(v.$('.agent-page') === b, false);
  assert.equal(v.$('.agent-page')!.classList.contains('following'), true);
  // the follow owner's observer and the prompt bubble's fold: a retired follow owner left behind would make it three
  assert.equal(observer.watching, 2, 'retired observers are disconnected before the replacement follows');
  await v.unmount();
  assert.equal(observer.watching, 0);
});

test('the same running agent key in a replacement native session gets a fresh follow owner', async (t) => {
  const observer = scrollObserver(t);
  withRuns(run('call-1'));
  await settle(() => setStore({ segments: { [CHAT]: [{ harness: 'opencode', nativeId: 'acp:opencode:A', start: 0 }] } }));
  const v = await render(page('call-1'));
  const first = v.$('.agent-page')!;
  Object.defineProperty(first, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(first, 'clientHeight', { configurable: true, value: 300 });
  first.scrollTop = 700;
  await settle(() => first.dispatchEvent(new window.Event('scroll') as any));
  first.scrollTop = 200;
  await settle(() => first.dispatchEvent(new window.Event('scroll') as any));
  assert.equal(first.classList.contains('following'), false);
  await settle(() => setStore({ segments: { [CHAT]: [{ harness: 'opencode', nativeId: 'acp:opencode:B', start: 0 }] } }));
  const replacement = v.$('.agent-page')!;
  assert.equal(replacement === first, false, 'native ownership comes from the real parent-turn source producer');
  assert.equal(replacement.classList.contains('following'), true);
  assert.equal(observer.watching, 2, "the follow owner's and the prompt fold's");
  await v.unmount();
  assert.equal(observer.watching, 0);
});

test('settled agents: the report once, and a no-result line when there is none', async () => {
  withRuns(
    run('A', { status: 'completed', report: 'Done.', prompt: '  ' }),
    run('B', { status: 'failed' }),
    run('C', { status: 'stopped' }),
    run('D', { status: 'completed' }),
  );
  T.putAgentItems(CHAT, 'A', [{ id: 'm', type: 'agentMessage', text: 'Done.' }] as any);
  let v = await render(page('A'));
  assert.equal(v.$('.agent-page-bubble'), null, 'a blank prompt shows no bubble');
  assert.equal(v.$('.agent-page-report'), null, 'the report equals the last message: shown once');
  assert.equal(v.$('.agent-page-note'), null);
  await v.unmount();
  const notes: (string | null)[] = [];
  for (const key of ['B', 'C', 'D']) {
    v = await render(page(key));
    notes.push(text(v.$('.agent-page-note')));
    await v.unmount();
  }
  assert.deepEqual(notes, ['No result — the agent failed', 'No result — the agent was stopped', 'No result']);
});

test('a stored transcript shows Loading while it loads, then the load error', async () => {
  let fail!: (e: Error) => void;
  T.setAgentThreadLoaderResolver(() => () => new Promise((_, reject) => (fail = reject)));
  withRuns(run('A', { status: 'completed', report: 'r' }));
  const v = await render(page());
  assert.equal(text(v.$('.agent-page-placeholder')), 'Loading…');
  await settle(() => fail(new Error('gone')));
  assert.equal(v.$('.agent-page-placeholder'), null);
  assert.equal(text(v.$('.agent-page-error')), "Couldn't load the agent's steps: gone");
  await v.unmount();
});

test('a replayed run names the model from its stored transcript and counts its calls when the run has none', async () => {
  const replayed = () =>
    withRuns(run('A', { status: 'completed', model: null, toolUses: 0, tokens: null, startedAt: null, completedAt: null, report: 'Done' }));
  replayed();
  T.putAgentItems(CHAT, 'A', [
    { id: 'm1', type: 'agentMessage', text: 'Looking' },
    { id: 'c1', type: 'commandExecution', command: 'ls', status: 'completed', commandActions: [] },
  ] as any);
  T.putAgentModel(CHAT, 'A', 'Haiku 5.5');
  const v = await render(page());
  assert.equal(text(v.$('.agent-page-model-value')), 'Haiku 5.5');
  assert.equal(text(v.$('.agent-page-stats')), '1 tool call');
  await v.unmount();
  // nothing loaded yet: no model and no made-up "0 tool calls"
  CHAT = `chat-${++chats}`;
  replayed();
  const w = await render(page());
  assert.equal(w.$('.agent-page-model'), null);
  assert.equal(text(w.$('.agent-page-stats')), '');
  await w.unmount();
});

test("a nested agent's page follows its status as its parent's transcript changes", async () => {
  withRuns(run('A'));
  const nested = (status: string, report: string | null) => ({
    id: 'n1',
    type: 'dynamicToolCall',
    agent: run('A.1', { prompt: 'Check', model: null, status, report }),
  });
  await settle(() => T.putAgentItems(CHAT, 'A', [nested('running', null)] as any));
  const v = await render(page('A.1'));
  assert.ok(v.$('.agent-spark'));
  // only the parent's transcript changed: the nested agent finished with its report
  await settle(() => T.putAgentItems(CHAT, 'A', [nested('completed', 'Lexer ok')] as any));
  assert.equal(v.$('.agent-page-report [data-stub="Markdown"]')!.dataset.text, 'Lexer ok');
  await v.unmount();
});

test('a settled agent that hands back no report but ends its transcript with a message shows no No result line', async () => {
  withRuns(run('A', { status: 'completed', report: null }));
  T.putAgentItems(CHAT, 'A', [{ id: 'm1', type: 'agentMessage', text: 'hi' }] as any);
  const v = await render(page());
  assert.equal(v.$('.agent-page-note'), null);
  // with nothing said at all there is still no result to show
  await settle(() => T.putAgentItems(CHAT, 'A', [{ id: 'm1', type: 'agentMessage', text: '  ' }] as any));
  assert.equal(text(v.$('.agent-page-note')), 'No result');
  await v.unmount();
});

test('a harness that shares no steps shows the prompt, the report and the status', async () => {
  withRuns(run('A', { transcript: 'summary', status: 'completed', report: 'Summary report' }), run('B', { transcript: 'summary' }));
  let v = await render(page());
  assert.equal(text(v.$('.agent-page-note')), "This harness doesn't share the agent's steps.");
  assert.equal(v.$('.agent-page-placeholder'), null);
  assert.equal(v.$('.agent-page-report [data-stub="Markdown"]')!.dataset.text, 'Summary report');
  assert.ok(v.$('.agent-page-stats'));
  await v.unmount();
  v = await render(page('B'));
  assert.ok(v.$('.agent-spark'));
  assert.equal(v.$('.agent-page-placeholder'), null);
  await v.unmount();
});

test('an agent that settles while watched keeps the spinner for 2.5 s until its report arrives; a finished one opened later does not wait', async () => {
  const { RESULT_HOLD_MS } = await import('../src/components/agents/AgentPage.tsx');
  withRuns(run('A'), run('B', { status: 'completed' }));
  const v = await render(page('A'));
  assert.ok(v.$('.agent-spark'));
  // a run with no report field at all settles the same way
  await settle(() => withRuns(run('A', { status: 'completed', report: undefined }), run('B', { status: 'completed' })));
  assert.ok(v.$('.agent-spark'));
  await settle(() => withRuns(run('A'), run('B', { status: 'completed' })));
  // it settles with no report: the spinner stays, with no "No result" and no stats
  await settle(() => withRuns(run('A', { status: 'completed' }), run('B', { status: 'completed' })));
  assert.ok(v.$('.agent-spark'));
  assert.equal(v.$('.agent-page-note'), null);
  assert.equal(v.$('.agent-page-stats'), null);
  // the report arrives during the hold: it shows at once
  await settle(() => withRuns(run('A', { status: 'completed', report: 'All done.' }), run('B', { status: 'completed' })));
  assert.equal(v.$('.agent-spark'), null);
  assert.equal(text(v.$('.agent-page-report [data-stub="Markdown"]')), '');
  assert.equal(v.$('.agent-page-report [data-stub="Markdown"]')!.dataset.text, 'All done.');
  await v.unmount();
  // the hold ends after 2.5 s with the no-result line
  const w = await render(page('A'));
  await settle(() => withRuns(run('A'), run('B', { status: 'completed' })));
  await settle(() => withRuns(run('A', { status: 'completed' }), run('B', { status: 'completed' })));
  assert.ok(w.$('.agent-spark'));
  await settle(() => new Promise((r) => setTimeout(r, RESULT_HOLD_MS + 100)));
  assert.equal(w.$('.agent-spark'), null);
  assert.equal(text(w.$('.agent-page-note')), 'No result');
  await w.unmount();
  // one that settles with its report already in hand shows it at once, with no hold
  withRuns(run('C'), run('B', { status: 'completed' }));
  const y = await render(page('C'));
  await settle(() => withRuns(run('C', { status: 'completed', report: 'Right away.' }), run('B', { status: 'completed' })));
  assert.equal(y.$('.agent-spark'), null);
  assert.ok(y.$('.agent-page-report'));
  await y.unmount();
  // a finished agent opened later shows its no-result line at once
  const x = await render(page('B'));
  assert.equal(x.$('.agent-spark'), null);
  assert.equal(text(x.$('.agent-page-note')), 'No result');
  await x.unmount();
});

test('an agent that polls: its repeated checks fold into one row, the running check staying out', async () => {
  withRuns(run('A'));
  const check = (n: number) => [
    { id: `s${n}`, type: 'sleep', durationMs: 30_000 },
    { id: `c${n}`, type: 'commandExecution', command: 'gh run view 1', status: 'completed', commandActions: [] },
  ];
  const say = (n: number) => ({ id: `m${n}`, type: 'agentMessage', text: `Still running (${n}).` });
  T.putAgentItems(CHAT, 'A', [...check(1), say(1), ...check(2), say(2), ...check(3), say(3), ...check(4)] as any);
  const v = await render(page());
  assert.equal(text(v.$('.agent-page-entries .poll-run .step-text')), 'Ran the same command 3 times, waited 1m 30s · gh run view 1');
  // the latest status and the running check are their own entries below it
  assert.equal(v.$$('.agent-page-entries > .commentary').length, 1);
  assert.ok(v.$('.agent-page-entries .step-row.active'));
  await v.unmount();
});
