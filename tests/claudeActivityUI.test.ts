// The working mark's activity line and a running group's row (src/components/thread/ClaudeActivity.tsx), with the
// running turn's token count (src/components/thread/turnTokens.tsx) read from a fake store, and the status slot under
// the task list the line renders into (src/components/thread/statusSlot.tsx).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, mockSource, stubStore } from './support/stubs.ts';

const { act, createElement: h } = await import('react');

const store = fakeStore<any>({ runtime: {} });
stubStore({ useStore: store.useStore });
mockSource('src/components/tasks/SessionsCount.tsx', { InlineCounts: ({ chatId }: any) => h('i', { 'data-count': chatId }) });
const { createRoot } = await import('react-dom/client');
const { ClaudeActivity, CLOCK_AFTER_MS, ROW_CLOCK_AFTER_MS, THINKING_WORD, thinkingWord } = await import(
  '../src/components/thread/ClaudeActivity.tsx'
);
const { InStatusSlot, StatusSlot } = await import('../src/components/thread/statusSlot.tsx');
const { ThinkingLine } = await import('../src/components/thread/view/ThinkingLine.tsx');
const { ActivityChat, turnTokens } = await import('../src/components/thread/turnTokens.tsx');

async function mount(t: any, element: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  await act(() => root.render(element));
  t.after(async () => {
    await act(() => root.unmount());
    host.remove();
  });
  return { host, render: (next: any) => act(() => root.render(next)) };
}

test('the line leads with the working mark for its activity; the words shimmer, the clock joins after two seconds', async (t) => {
  const { host, render } = await mount(t, h(ClaudeActivity, { label: 'Reading a.ts', activity: 'read', elapsedMs: 1_000 }));
  const mark = host.querySelector('.claude-activity > .claude-activity-mark > .working-mark')!;
  assert.equal(mark.getAttribute('data-activity'), 'read');
  assert.equal(host.querySelector('.claude-activity-label')!.className, 'claude-activity-label shimmer-text');
  assert.equal(host.querySelector('.claude-activity-time'), null, 'under two seconds: no clock yet');
  assert.equal(CLOCK_AFTER_MS, 2000);
  await render(h(ClaudeActivity, { label: 'Reading a.ts', activity: 'read', elapsedMs: CLOCK_AFTER_MS }));
  assert.equal(host.querySelector('.claude-activity-time')!.textContent, '2s');
  // no words of its own: the mark and the clock, and "Thinking" while the model thinks
  await render(h(ClaudeActivity, { activity: 'think', thinking: true, elapsedMs: 500 }));
  assert.equal(host.querySelector('.claude-activity-label'), null);
  assert.equal(host.querySelector('.claude-activity-thinking')!.textContent, 'Thinking…');
  await render(h(ClaudeActivity, { label: '', activity: 'think', thinking: true, elapsedMs: 9_000 }));
  assert.equal(host.querySelector('.claude-activity-label'), null);
  assert.equal(host.querySelector('.claude-activity-thinking')!.textContent, '· Thinking…');
  // a step with words says those instead
  await render(h(ClaudeActivity, { label: 'Running npm test', activity: 'code', thinking: true, elapsedMs: 9_000 }));
  assert.equal(host.querySelector('.claude-activity-thinking'), null);
  await render(h(ClaudeActivity, { activity: 'default', elapsedMs: 9_000 }));
  assert.equal(host.querySelector('.claude-activity-thinking'), null);
  assert.equal(host.querySelector('.working-mark')!.getAttribute('data-activity'), 'default');
});

test('a running step without output is a plain status line with its elapsed time', async (t) => {
  const { host, render } = await mount(t, h(ClaudeActivity, { label: 'Thinking', activity: 'think', elapsedMs: 65_000 }));
  const status = host.querySelector('[role="status"].claude-activity')!;
  assert.equal(status.querySelector('.claude-activity-label')!.textContent, 'Thinking');
  assert.equal(status.querySelector('.claude-activity-time')!.textContent, '1m 5s');
  assert.equal(host.querySelector('.claude-activity-chevron'), null);
  assert.equal(host.querySelector('button'), null);
  // no start time yet, or an unusable one, shows no clock
  await render(h(ClaudeActivity, { label: 'Thinking', activity: 'think', elapsedMs: null }));
  assert.equal(host.querySelector('.claude-activity-time'), null);
  await render(h(ClaudeActivity, { label: 'Thinking', activity: 'think', elapsedMs: Number.NaN }));
  assert.equal(host.querySelector('.claude-activity-time'), null);
  // a toggle with nothing to show, or output with no toggle, is not expandable
  await render(h(ClaudeActivity, { label: 'Running', activity: 'code', elapsedMs: 0, onToggle: () => {} }));
  assert.equal(host.querySelector('button'), null);
  await render(h(ClaudeActivity, { label: 'Running', activity: 'code', elapsedMs: 0 }, h('pre', null, 'out')));
  assert.equal(host.querySelector('button'), null);
  assert.equal(host.querySelector('pre'), null);
});

test('a step with output toggles open and shows a chevron', async (t) => {
  let toggles = 0;
  const view = (open?: boolean) =>
    h(
      ClaudeActivity,
      {
        label: 'Running a command',
        activity: 'code',
        elapsedMs: 3_000,
        open,
        onToggle: () => {
          toggles++;
        },
      },
      h('pre', null, 'npm test'),
    );
  const { host, render } = await mount(t, view());
  const button = host.querySelector('button.claude-activity.expandable') as HTMLButtonElement;
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.ok(host.querySelector('.claude-activity-chevron'));
  assert.equal(host.querySelector('.step.claude-step')!.classList.contains('open'), false);
  assert.equal(host.querySelector('.step-body pre'), null);
  await act(() => {
    button.click();
  });
  assert.equal(toggles, 1);
  await render(view(true));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  assert.equal(host.querySelector('button')!.getAttribute('aria-expanded'), 'true');
  assert.equal(host.querySelector('.step.claude-step')!.classList.contains('open'), true);
  assert.equal(host.querySelector('.step-body pre')!.textContent, 'npm test');
  assert.equal(host.querySelector('.claude-activity-time')!.textContent, '3s');
});

const usage = (totalTokens: number) => ({ total: { totalTokens }, last: { totalTokens: 0 }, modelContextWindow: null }) as any;

test("the running turn's tokens are the chat's total less its total at the turn's start, once known and above zero", () => {
  assert.equal(turnTokens(undefined), null);
  assert.equal(turnTokens({ activeTurnId: null, tokenUsage: usage(900), turnStartTokens: 100 }), null, 'no turn running');
  assert.equal(turnTokens({ activeTurnId: 't', tokenUsage: usage(900), turnStartTokens: null }), null, 'start unknown');
  assert.equal(turnTokens({ activeTurnId: 't', tokenUsage: usage(900) }), null, 'start never recorded');
  assert.equal(turnTokens({ activeTurnId: 't', tokenUsage: null, turnStartTokens: 100 }), null, 'usage on request only');
  assert.equal(turnTokens({ activeTurnId: 't', tokenUsage: usage(100), turnStartTokens: 100 }), null, 'nothing used yet');
  assert.equal(turnTokens({ activeTurnId: 't', tokenUsage: usage(12_400), turnStartTokens: 100 }), 12_300);
});

test("the activity line shows the chat's running-turn tokens after its clock, and nothing outside a chat", async (t) => {
  store.setState({ runtime: { c1: { activeTurnId: 't', tokenUsage: usage(122_700), turnStartTokens: 100 } } });
  const line = h(ClaudeActivity, { label: 'Working', activity: 'default', elapsedMs: 62_000 });
  const { host, render } = await mount(t, h(ActivityChat.Provider, { value: 'c1' }, line));
  const tokens = host.querySelector('.claude-activity-time + .claude-activity-tokens')!;
  assert.equal(tokens.textContent, '· 123k tokens');
  await act(async () => store.setState({ runtime: { c1: { activeTurnId: null, tokenUsage: usage(122_700), turnStartTokens: 100 } } }));
  assert.equal(host.querySelector('.claude-activity-tokens'), null, 'the turn ended');
  await render(line);
  assert.equal(host.querySelector('.claude-activity-tokens'), null, 'no chat around it');
});

test('a running group\'s row: its words or "Thinking…", the clock from five seconds, no tokens, and what follows beside the toggle', async (t) => {
  store.setState({ runtime: { c1: { activeTurnId: 't', tokenUsage: usage(122_700), turnStartTokens: 100 } } });
  const row = (props: any, children?: any) =>
    h(ActivityChat.Provider, { value: 'c1' }, h(ClaudeActivity, { row: true, activity: 'code', ...props }, children));
  const { host, render } = await mount(t, row({ label: 'Running npm test', elapsedMs: ROW_CLOCK_AFTER_MS - 1 }));
  assert.equal(ROW_CLOCK_AFTER_MS, 5000);
  assert.equal(host.querySelector('.claude-activity-label')!.textContent, 'Running npm test');
  assert.equal(host.querySelector('.claude-activity-time'), null, 'under five seconds: no clock yet');
  await render(row({ label: 'Running npm test', elapsedMs: 21_000, trailing: h('i', null, 'live') }));
  assert.deepEqual(
    [...host.querySelector('.claude-activity')!.children].map((el) => el.className),
    ['claude-activity-mark', 'claude-activity-label shimmer-text', 'claude-activity-time', ''],
    'the mark, the words, the clock; no tokens; what follows after',
  );
  assert.equal(host.querySelector('.claude-activity-time')!.textContent, '21s');
  // thinking: "Thinking…" in the words' place however long, before the clock
  await render(row({ thinking: true, elapsedMs: 600_000 }));
  const words = host.querySelector('.claude-activity-label')!;
  assert.equal(words.textContent, THINKING_WORD);
  assert.equal(words.className, 'claude-activity-label claude-activity-thinking shimmer-text');
  assert.equal(words.nextElementSibling!.className, 'claude-activity-time');
  // no words and not thinking: the mark and the clock
  await render(row({ elapsedMs: 9_000 }));
  assert.equal(host.querySelector('.claude-activity-label'), null);
  // something to open: what follows the row sits beside its toggle, not inside it (a live link is a button of its own)
  let toggles = 0;
  await render(
    row(
      { label: 'Running ls', elapsedMs: 9_000, onToggle: () => toggles++, trailing: h('button', { className: 'live' }) },
      h('pre', null, 'out'),
    ),
  );
  const toggle = host.querySelector('.claude-step > .claude-step-head > button.claude-activity.expandable')!;
  assert.equal(toggle.querySelector('.live'), null);
  assert.ok(host.querySelector('.claude-step-head > button.live'));
  assert.ok(toggle.querySelector('.claude-activity-chevron'));
  await act(() => (toggle as HTMLButtonElement).click());
  assert.equal(toggles, 1);
});

test('the status slot takes the line when the view has one, and leaves it in place when not', async (t) => {
  const slot = document.createElement('div');
  document.body.append(slot);
  t.after(() => slot.remove());
  const line = h(InStatusSlot, null, h('span', { className: 'line' }, 'Thinking'));
  const { host, render } = await mount(t, h('div', { className: 'turn' }, line));
  assert.equal(host.querySelector('.turn > .line')!.textContent, 'Thinking', 'no slot: in place');
  await render(h(StatusSlot.Provider, { value: slot as any }, h('div', { className: 'turn' }, line)));
  assert.equal(host.querySelector('.line'), null);
  assert.equal(slot.querySelector('.line')!.textContent, 'Thinking');
});

test('the thinking line: the dots line in the status slot, or the shimmering row in place for the Codex look', async (t) => {
  const slot = document.createElement('div');
  document.body.append(slot);
  t.after(() => slot.remove());
  const line = (ux: string) =>
    h(StatusSlot.Provider, { value: slot as any }, h(ThinkingLine, { ux: ux as any, elapsedMs: 2_000, chatId: 'c1', activity: 'think' }));
  const { host, render } = await mount(t, line('dots'));
  // no words of its own: the thinking mark and the clock
  assert.equal(slot.querySelector('.placeholder-reveal .claude-activity-label'), null);
  assert.equal(slot.querySelector('.placeholder-reveal .working-mark')!.getAttribute('data-activity'), 'think');
  assert.equal(slot.querySelector('.placeholder-reveal .claude-activity-time')!.textContent, '2s');
  assert.equal(slot.querySelector('.claude-activity-thinking')!.textContent, '· Thinking…');
  assert.equal(slot.querySelector('.claude-activity [data-count]')!.getAttribute('data-count'), 'c1');
  assert.equal(host.querySelector('.claude-activity'), null);
  await render(
    h(StatusSlot.Provider, { value: slot as any }, h(ThinkingLine, { ux: 'dots', elapsedMs: 500, chatId: 'c1', activity: 'think' })),
  );
  assert.equal(slot.querySelector('.claude-activity-thinking')!.textContent, 'Thinking…');
  await render(
    h(StatusSlot.Provider, { value: slot as any }, h(ThinkingLine, { ux: 'dots', elapsedMs: 2_000, chatId: 'c1', activity: 'default' })),
  );
  assert.equal(slot.querySelector('.claude-activity-thinking'), null, 'ordinary work does not claim an explicit thinking phase');
  await render(line('shimmer'));
  assert.equal(slot.querySelector('.claude-activity'), null);
  assert.ok(host.querySelector('.step-row.active'));
  assert.match(host.querySelector('.step-row.active')!.textContent!, /Thinking/);
  assert.equal(host.querySelector('.step-row [data-count]')!.getAttribute('data-count'), 'c1');
});

test('a new chat starting shows the activity line, or the shimmering label in the older look', async (t) => {
  const { StartingChat } = await import('../src/components/thread/StartingChat.tsx');
  const { host, render } = await mount(t, h(StartingChat, { text: 'Hi', attachments: [], ux: 'dots' }));
  assert.equal(host.querySelector('.claude-activity .claude-activity-label')!.textContent, 'Starting chat');
  assert.equal(host.querySelector('.working-mark')!.getAttribute('data-activity'), 'think');
  await render(h(StartingChat, { text: 'Hi', attachments: [], ux: 'shimmer' }));
  assert.equal(host.querySelector('.claude-activity'), null);
  assert.match(host.querySelector('.step-row.active')!.textContent!, /^Starting chat/);
});

test('the thinking word grows with this stretch of thinking, as in Claude Desktop, and starts over after a step', async (t) => {
  assert.deepEqual([0, 14_999, 15_000, 30_000, 45_000, 60_000, 600_000].map(thinkingWord), [
    'Thinking…',
    'Thinking…',
    'Still thinking…',
    'Thinking more…',
    'Thinking some more…',
    'Almost done thinking…',
    'Almost done thinking…',
  ]);
  const think = (elapsedMs: number | null, label?: string) => h(ClaudeActivity, { label, activity: 'think', thinking: true, elapsedMs });
  const word = (host: any) => host.querySelector('.claude-activity-thinking')?.textContent ?? null;
  // no clock yet (a chat reopened mid-turn): the stretch starts when the clock first reads, not at the turn's start
  const { host, render } = await mount(t, think(null));
  assert.equal(word(host), 'Thinking…');
  assert.equal(host.querySelector('.claude-activity-thinking')!.className, 'claude-activity-thinking shimmer-text');
  await render(think(70_000));
  assert.equal(word(host), '· Thinking…');
  await render(think(90_000));
  assert.equal(word(host), '· Still thinking…');
  // a step with words of its own ends the stretch; thinking after it starts the word over from that moment
  await render(think(40_000, 'Running npm test'));
  assert.equal(word(host), null);
  await render(think(41_000));
  assert.equal(word(host), '· Thinking…');
  await render(think(71_000));
  assert.equal(word(host), '· Thinking more…');
  await render(think(101_000));
  assert.equal(word(host), '· Almost done thinking…');
});
