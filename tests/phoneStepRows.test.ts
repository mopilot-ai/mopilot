// A step row beyond its line: how far it got (running, failed), what it read or ran, its screenshot and where it worked; and the agent's bookkeeping steps the transcript leaves out or folds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, createElement, createRoot, flush } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
const stepRowsPath = '../mobile/src/presentation/stepRows';
const threadPath = '../mobile/src/presentation/thread';
const bubblePath = '../mobile/src/components/MessageBubble';
const picturePath = '../mobile/src/components/StepPicture';
const { savedExtras, liveStep, tidySteps } = await import(stepRowsPath);
const { row, update, snapshot, displayRows } = await import(threadPath);
const { MessageBubble, StepRow, ToolRun } = await import(bubblePath);
const { SMALL_WIDTH } = await import(picturePath);
const appPath = '../mobile/src/MobileApp';
const cachePath = '../mobile/src/presentation/threadCache';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

async function mount(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return {
    host,
    root,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const styleOf = (el: Element | null | undefined) => JSON.parse(el?.getAttribute('data-style') ?? '{}');
const span = (host: HTMLElement, text: string) => [...host.querySelectorAll('span')].filter((n) => n.textContent === text).at(-1);
const button = (host: HTMLElement, label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;

test('a saved step row keeps its state, detail, embedded screenshot and surface; anything else is left out', () => {
  assert.deepEqual(
    row({ role: 'step', text: 'Click failed', state: 'failed', detail: 'Input', thumbnail: PNG, surface: 'chrome' }, 'rows'),
    {
      role: 'step',
      text: 'Click failed',
      kind: 'other',
      ms: null,
      state: 'failed',
      detail: 'Input',
      thumbnail: PNG,
      surface: 'chrome',
    },
  );
  assert.deepEqual(savedExtras({ state: 'running' }), { state: 'running' });
  // a state the phone does not know, a picture it would have to fetch or that is too large, and empty strings
  assert.deepEqual(savedExtras({ state: 'done', thumbnail: 'https://x.test/a.png', detail: '', surface: 7 }), {});
  assert.deepEqual(savedExtras({ thumbnail: `${PNG}${'A'.repeat(400_000)}` }), {});
  assert.deepEqual(savedExtras({ thumbnail: 'data:image/svg+xml;base64,PHN2Zz4=' }), {});
  // your messages and replies carry none of it
  assert.deepEqual(row({ role: 'user', text: 'Hi', state: 'failed' }, 'rows'), { role: 'user', text: 'Hi' });
});

test('a live tool call reads as its saved row will: what it did, in each state, never the item type', () => {
  const click = { type: 'mcpToolCall', server: 'mopilot_chrome', tool: 'computer', arguments: { action: 'left_click' } };
  assert.deepEqual(row({ ...click, status: 'inProgress' }, 'items'), {
    role: 'step',
    text: 'Clicking',
    state: 'running',
    kind: 'other',
    ms: null,
  });
  assert.deepEqual(row({ ...click, status: 'completed', durationMs: 1200 }, 'items'), {
    role: 'step',
    text: 'Clicked',
    kind: 'other',
    ms: 1200,
  });
  assert.equal(row({ ...click, status: 'failed' }, 'items').text, 'Click failed');
  assert.equal(row({ ...click, status: 'failed' }, 'items').state, 'failed');
  assert.equal(
    row({ type: 'dynamicToolCall', tool: 'mcp__mopilot_browser__navigate', arguments: { url: 'https://example.com/a' } }, 'items').text,
    'Opened example.com',
  );
  // other live steps keep their own line, with the state their status says
  assert.deepEqual(liveStep({ type: 'commandExecution', status: 'failed' }, 'npm test'), { text: 'npm test', state: 'failed' });
  assert.deepEqual(liveStep({ type: 'commandExecution', status: 'completed' }, 'npm test'), { text: 'npm test' });
});

test('a tool line the phone cannot word reads as the item, rather than breaking the chat', () => {
  const canParse = URL.canParse;
  // a runtime whose URL lacks what the wording uses
  (URL as any).canParse = undefined;
  try {
    const item = {
      type: 'mcpToolCall',
      server: 'mopilot_browser',
      tool: 'navigate',
      arguments: { url: 'https://example.com' },
      status: 'inProgress',
    };
    assert.deepEqual(liveStep(item, 'mcpToolCall'), { text: 'navigate', state: 'running' });
  } finally {
    URL.canParse = canParse;
  }
});

test('a call still running when the next turn starts runs no more in the saved history; a failure stays a failure', () => {
  let t = snapshot({
    items: [],
    session: { turn: 'inProgress' },
    rev: 1,
    itemsShape: 'items',
    feedSeq: 1,
    liveTurn: { id: 't1', status: 'inProgress' },
  });
  t = update(t, {
    ev: 'items.append',
    feedSeq: 2,
    items: [
      { id: 'a', type: 'mcpToolCall', server: 'mopilot_chrome', tool: 'computer', arguments: { action: 'scroll' }, status: 'inProgress' },
      { id: 'b', type: 'mcpToolCall', server: 'mopilot_chrome', tool: 'computer', arguments: { action: 'type' }, status: 'failed' },
    ],
  });
  assert.deepEqual(
    displayRows(t).map((r) => [r.text, r.state]),
    [
      ['Scrolling', 'running'],
      ['Couldn’t type', 'failed'],
    ],
  );
  t = update(t, { ev: 'turn.state', feedSeq: 3, status: 'inProgress', turnId: 't2' });
  assert.deepEqual(
    displayRows(t).map((r) => [r.text, r.state]),
    [
      ['Scrolling', undefined],
      ['Couldn’t type', 'failed'],
    ],
  );
});

test('the task list, the wrap-up and a skill load are left out; a failed one stays', () => {
  const step = (text: string, role = 'step') => ({ role, text });
  const rows = [
    step('Hi', 'user'),
    step('Updated task list'),
    step('Updating task list', 'live'),
    step('Used Skill'),
    step('Using Skill'),
    step('Wrapped up'),
    step('Wrapping up'),
    step('Couldn’t update task list'),
    step('Clicked'),
    step('Done.', 'assistant'),
  ];
  assert.deepEqual(
    tidySteps(rows).map((r) => r.text),
    ['Hi', 'Couldn’t update task list', 'Clicked', 'Done.'],
  );
  // a message that happens to read like one is a message
  assert.deepEqual(
    tidySteps([step('Wrapped up', 'assistant')]).map((r) => r.text),
    ['Wrapped up'],
  );
});

test('loading more tools reads "Loaded tools", once for a run of loads, whichever name the harness gave the tool', () => {
  const step = (text: string, key: string, role = 'step') => ({ role, text, key });
  assert.deepEqual(
    tidySteps([
      step('Used ToolSearch', 'a'),
      step('Used mcp__sage_ab12__browser_more_tools', 'b'),
      step('Using sage_ab12/more_tools', 'c', 'live'),
      step('Clicked', 'd'),
      step('Used more_tools', 'e'),
      step('Ok', 'f', 'assistant'),
      step('Used ToolSearch', 'g'),
      step('Couldn’t use ToolSearch', 'h'),
    ]),
    [
      // the run keeps its first row's key, so it is not drawn anew as more loads join it; the latest says it still loads
      step('Loading tools', 'a'),
      step('Clicked', 'd'),
      step('Loaded tools', 'e'),
      step('Ok', 'f', 'assistant'),
      step('Loaded tools', 'g'),
      step('Couldn’t use ToolSearch', 'h'),
    ],
  );
});

test('a running step reads darker, a failed one red, a step in Chrome says so; a tap shows what it read or ran', async () => {
  const v = await mount(
    createElement('div', null, [
      createElement(StepRow, { key: 'r', text: 'Clicking', state: 'running' }),
      createElement(StepRow, { key: 'f', text: 'Click failed', state: 'failed', detail: 'Input (preview)\n{"x":1}' }),
      createElement(StepRow, { key: 'c', text: 'Scrolled', surface: 'chrome' }),
      createElement(StepRow, { key: 'o', text: 'Read the page', surface: 'elsewhere' }),
    ]),
  );
  const ink = styleOf(span(v.host, 'Clicking')).color;
  const failed = styleOf(span(v.host, 'Click failed')).color;
  assert.notEqual(ink, failed);
  assert.notEqual(ink, styleOf(span(v.host, 'Scrolled · Chrome')).color);
  assert.ok(button(v.host, 'Activity: Scrolled, in Chrome'), 'the place is read out too');
  assert.ok(button(v.host, 'Activity: Read the page'), 'a place the phone does not know is not named');
  assert.doesNotMatch(v.host.textContent!, /\{"x":1\}/, 'the detail waits for a tap');
  await act(async () => button(v.host, 'Activity: Click failed').click());
  const detail = span(v.host, 'Input (preview)\n{"x":1}');
  assert.ok(detail);
  assert.equal(styleOf(detail).fontFamily, 'Menlo');
  await act(async () => button(v.host, 'Activity: Click failed').click());
  assert.equal(span(v.host, 'Input (preview)\n{"x":1}'), undefined);
  await v.done();
});

test("a step's screenshot shows small under it, full width on a tap and small again on another", async () => {
  const v = await mount(createElement(MessageBubble, { role: 'step', text: 'Took a screenshot', thumbnail: PNG, surface: 'chrome' }));
  const img = v.host.querySelector('img')!;
  assert.equal(img.getAttribute('src'), PNG);
  assert.equal(styleOf(button(v.host, 'Show the screenshot larger')).alignSelf, 'flex-start');
  await act(async () => button(v.host, 'Show the screenshot larger').click());
  assert.equal(styleOf(button(v.host, 'Show the screenshot smaller')).alignSelf, 'stretch');
  await act(async () => button(v.host, 'Show the screenshot smaller').click());
  assert.ok(button(v.host, 'Show the screenshot larger'));
  assert.equal(SMALL_WIDTH, 132);
  await v.done();
});

test('a folded run shows its latest screenshot under its line; opened, each step shows its own and its state', async () => {
  const steps = [
    { key: 'a', role: 'step', text: 'Took a screenshot', thumbnail: 'data:image/png;base64,AAAA' },
    { key: 'b', role: 'step', text: 'Click failed', state: 'failed', detail: 'Result (preview)\nno target' },
    { key: 'c', role: 'step', text: 'Zoomed in', thumbnail: PNG, surface: 'chrome' },
  ];
  const v = await mount(createElement(ToolRun, { steps, summary: '3 steps', running: false }));
  assert.deepEqual(
    [...v.host.querySelectorAll('img')].map((i) => i.getAttribute('src')),
    [PNG],
  );
  await act(async () => button(v.host, '3 steps').click());
  assert.deepEqual(
    [...v.host.querySelectorAll('img')].map((i) => i.getAttribute('src')),
    ['data:image/png;base64,AAAA', PNG],
  );
  assert.ok(button(v.host, 'Activity: Zoomed in, in Chrome'));
  await act(async () => button(v.host, 'Activity: Click failed').click());
  assert.ok(span(v.host, 'Result (preview)\nno target'));
  await v.done();
  const plain = await mount(
    createElement(ToolRun, { steps: [steps[1], { key: 'd', role: 'step', text: 'Clicked' }], summary: '2 steps', running: false }),
  );
  assert.equal(plain.host.querySelector('img'), null);
  await plain.done();
});

test('a chat leaves its bookkeeping steps out on screen, and its offline cache keeps only what the cache draws', async () => {
  const { MobileApp } = await import(appPath);
  const { recentRows, forgetRows } = await import(cachePath);
  forgetRows();
  const online = {
    phase: 'online',
    generation: 1,
    user: { id: 'u' },
    pairs: [{ pairId: 'p', macId: 'm', name: 'Mac' }],
    selectedPair: 'p',
    safetyNumber: null,
    pendingPair: false,
    error: null,
    presence: {},
    reconnect: null,
  };
  const follow = {
    rev: 1,
    feedSeq: 0,
    session: { turn: 'idle', cards: [] },
    itemsShape: 'rows',
    items: [
      { role: 'user', text: 'Look at the page' },
      { role: 'step', text: 'Took a screenshot', thumbnail: PNG, surface: 'chrome', detail: 'Input (preview)' },
      { role: 'assistant', text: 'It shows a login form.' },
      { role: 'step', text: 'Wrapped up' },
    ],
  };
  const s = scripted(
    (m: string) => (m === 'chats.recent' ? { chats: [{ id: 'c1', title: 'Page' }] } : m === 'chat.follow' ? follow : undefined),
    online,
  );
  s.runtime.start = async () => {};
  s.runtime.subscribe = () => () => {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime })));
  await flush();
  await click('Open chat Page');
  assert.match(host.textContent!, /It shows a login form\./);
  assert.doesNotMatch(host.textContent!, /Wrapped up/);
  assert.equal(host.querySelector('img')?.getAttribute('src'), PNG);
  // the cache's rows draw role and text only: the screenshot and the detail stay with the live chat
  assert.deepEqual(recentRows(JSON.stringify(['u', 'p', 'c1'])), [
    { key: JSON.stringify([JSON.stringify(['user', 'Look at the page']), 0]), role: 'user', text: 'Look at the page' },
    { key: JSON.stringify([JSON.stringify(['step', 'Took a screenshot']), 0]), role: 'step', text: 'Took a screenshot' },
    {
      key: JSON.stringify([JSON.stringify(['assistant', 'It shows a login form.']), 0]),
      role: 'assistant',
      text: 'It shows a login form.',
    },
  ]);
  await act(async () => root.unmount());
  host.remove();
});
