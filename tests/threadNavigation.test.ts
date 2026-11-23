import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
const window = new Window();
(globalThis as any).CSS = window.CSS;
const { navigationId, navigationItems, navigationAnchor, navigationTurn, keepNavigation } = await import(
  '../src/session/threadNavigation.ts'
);
const { loadHistoryPage } = await import('../src/session/threadHistory.ts');
const { sidebarMaxWidth, sidebarDragWidth, sidebarKeyWidth, finishSidebarResize } = await import('../src/lib/sidebarSizing.ts');
after(async () => {
  await window.happyDOM.close();
});
const user = (id = 'u', text = 'Question', content?: any[]) => ({ id, type: 'userMessage', content: content ?? [{ type: 'text', text }] });
const reply = (text = 'Answer', phase?: string) => ({ id: 'a', type: 'agentMessage', text, phase });
const turn = (items: any[], status = 'completed', extra = {}) => ({ id: 't', items, status, ...extra }) as any;

test('sidebar can track the pointer to zero, retains saved width on collapse, and clamps reopening', () => {
  assert.equal(sidebarDragWidth(288, -288, 1200), 0);
  assert.equal(sidebarDragWidth(288, -999, 1200), 0);
  assert.equal(sidebarDragWidth(288, -200, 1200), 88);
  assert.equal(sidebarDragWidth(288, -241, 1200), 0);
  assert.equal(sidebarDragWidth(288, -240, 1200), 48);
  // the window keeps the chat's 440px minimum; a side pane beside the chat keeps its 400px too
  assert.equal(sidebarDragWidth(288, 1000, 744), 304);
  assert.equal(sidebarDragWidth(288, 1000, 1144, 400), 304);
  assert.equal(sidebarDragWidth(288, 1000, 1000, 400), 200);
  assert.equal(sidebarMaxWidth(200), 200);
  assert.equal(sidebarMaxWidth(1500), 560);
  const calls: any[] = [];
  const resize = (v: number) => calls.push(['resize', v]);
  const close = () => calls.push(['close']);
  const save = (v: number) => calls.push(['save', v]);
  finishSidebarResize(99, resize, close, save);
  assert.deepEqual(calls.splice(0), [['resize', 0], ['close']]);
  finishSidebarResize(100, resize, close, save);
  assert.deepEqual(calls.splice(0), [
    ['resize', 200],
    ['save', 200],
  ]);
  finishSidebarResize(340, resize, close, save);
  assert.deepEqual(calls, [
    ['resize', 340],
    ['save', 340],
  ]);
});

test('sidebar keyboard closes at the minimum and supports bounded resize keys', () => {
  for (const [key, width, expected] of [
    ['Escape', 200, null],
    ['Home', 300, 0],
    ['ArrowLeft', 200, 0],
    ['ArrowLeft', 300, 290],
    ['ArrowRight', 0, 200],
    ['ArrowRight', 300, 310],
    ['ArrowRight', 560, 560],
    ['End', 300, 560],
  ] as const)
    assert.equal(sidebarKeyWidth(key, width, 1400), expected);
});

test('Claude navigation IDs survive live-to-history replay and distinguish follow-ups', () => {
  const uuid = '12345678-1234-1234-1234-123456789abc';
  assert.equal(navigationId('ct-' + uuid, 'local-first'), navigationId('h-' + uuid, 'persisted-first'));
  assert.notEqual(navigationId('ct-' + uuid, 'local-first'), navigationId('h-' + uuid, 'follow-up', 1));
  assert.notEqual(navigationId('t', 'a'), navigationId('t', 'b'));
});

test("the rail's entries keep their array while a recompute holds the same entries, and change with any field", () => {
  const entry = (extra: any = {}) => ({
    id: 'a',
    prompt: 'Go',
    response: 'Done',
    outputs: ['x.ts'],
    canBookmark: true,
    find: { said: 'Go', replies: ['Done'] },
    ...extra,
  });
  const shown = [entry()];
  // the running turn's entries are recomputed as new objects on every delta
  assert.equal(keepNavigation(shown, [entry()]), shown);
  assert.equal(keepNavigation(shown, shown.slice()), shown);
  for (const changed of [
    [entry(), entry({ id: 'b' })],
    [entry({ id: 'b' })],
    [entry({ prompt: 'Stop' })],
    [entry({ response: 'Done, and more' })],
    [entry({ canBookmark: false })],
    [entry({ outputs: ['x.ts', 'y.ts'] })],
    [entry({ outputs: ['y.ts'] })],
    [entry({ find: { said: 'Stop', replies: ['Done'] } })],
    [entry({ find: { said: 'Go', replies: ['Done', 'More'] } })],
    [entry({ find: { said: 'Go', replies: ['Changed'] } })],
  ])
    assert.equal(keepNavigation(shown, changed), changed);
});

test('preview matches final replies, plans, reviews and outputs', () => {
  const result = navigationItems([
    turn([
      user(),
      reply('working', 'commentary'),
      reply('Final', 'final_answer'),
      { type: 'fileChange', changes: [{ path: '/src/a.ts' }, { path: '/src/a.ts' }, {}] },
      { type: 'fileChange' },
      { type: 'imageGeneration' },
    ]),
  ]);
  assert.equal(result[0].response, 'Final');
  assert.deepEqual(result[0].outputs, ['a.ts', 'Edited file', 'Generated image']);
  assert.equal(result[0].canBookmark, true);
  assert.equal(navigationItems([turn([user(), { id: 'p', type: 'plan', text: 'Proposed plan' }])])[0].response, 'Proposed plan');
  assert.equal(
    navigationItems([turn([user(), { id: 'r', type: 'exitedReviewMode', review: 'Review complete' }])])[0].response,
    'Review complete',
  );
  assert.equal(navigationItems([turn([user(), reply('Plan reply')], 'completed', { planMode: true })])[0].response, 'Plan reply');
  // a plan approved mid-turn is carried out in the same turn: the turn's reply is its response, not the plan
  const approved = { id: 'p', type: 'plan', text: 'Proposed plan', approvedInTurn: true };
  assert.equal(navigationItems([turn([user(), approved, reply('Implemented')])])[0].response, 'Implemented');
  // one nothing follows (rejected) still ends the turn
  assert.equal(navigationItems([turn([user(), reply('Here it is'), approved])])[0].response, 'Proposed plan');
});

test('follow-ups preview only their own reply and keep independent anchors', () => {
  const items = navigationItems([turn([user('u1', 'First'), reply('First reply'), user('u2', 'Second'), reply('Final reply')])]);
  assert.deepEqual(
    items.map((i) => i.response),
    ['First reply', 'Final reply'],
  );
  assert.notEqual(items[0].id, items[1].id);
  assert.equal(navigationItems([turn([user('u1'), user('u2')])])[0].response, '');
});

test('empty or failed turns have clear previews and async questions never masquerade as final replies', () => {
  assert.equal(navigationItems([turn([user()], 'inProgress')])[0].response, 'Working…');
  assert.equal(navigationItems([turn([user()], 'failed', { error: { message: 'bad' } })])[0].response, 'This turn ended with an error.');
  assert.equal(navigationItems([turn([user()], 'interrupted')])[0].response, 'Stopped');
  assert.equal(navigationItems([turn([user()])])[0].response, 'No reply');
  assert.equal(
    navigationItems([
      turn([user(), { id: 'q', type: 'agentMessage', text: 'Ask', questions: [{ title: 'Choose' }], phase: 'final_answer' }]),
    ])[0].response,
    'No reply',
  );
  assert.equal(navigationItems([turn([user()], 'completed', { id: 'pending-t' })])[0].canBookmark, false);
  assert.equal(navigationItems([turn([user('local-u')])])[0].canBookmark, false);
  assert.equal(
    navigationItems([turn([user('local-u')], 'completed', { id: 'ct-12345678-1234-1234-1234-123456789abc' })])[0].canBookmark,
    true,
  );
});

test('context, attachment and voice messages recover a recognizable prompt without empty marks', () => {
  const prompts = [
    user('image', '', [{ type: 'image' }, { type: 'localImage' }]),
    user('mention', '', [{ type: 'mention', name: 'Named' }, { type: 'skill', path: '/tools/skill.md' }, { type: 'mention' }]),
    user('file', '# Files mentioned by the user:\n## example.ts: /tmp/example.ts\n\n## My request:\n'),
    user('selection', '# Selected text:\n\n## Selection 1\nUseful selection\n\n## My request:\n'),
    user(
      'annotation',
      '# Response annotations:\n\n<response-annotations>[{"text":"Original reply","annotation":"Fix this"}]</response-annotations>\n\n## My request:\n',
    ),
    user('voice', '<realtime_delegation><input>Voice request</input></realtime_delegation>'),
  ];
  const values = prompts.map((u) => navigationItems([turn([u])])[0]?.prompt);
  assert.deepEqual(values.slice(0, 2), ['Image, Image', 'Named, skill.md, Attachment']);
  assert.equal(values[2], 'example.ts');
  assert.equal(values[3], 'Useful selection');
  assert.equal(values[4], 'Fix this');
  assert.equal(
    navigationItems([
      turn([user('quote', '# Response annotations:\n<response-annotations>[{"text":"Quote"}]</response-annotations>\n## My request:\n')]),
    ])[0].prompt,
    'Quote',
  );
  assert.equal(values[5], 'Voice request');
  assert.deepEqual(
    navigationItems([
      turn([{ id: 'u', type: 'userMessage' }]),
      turn([user('flush', '<realtime_delegation><source>transcript_tail_flush</source></realtime_delegation>')]),
      turn([]),
    ]),
    [],
  );
});

function historyFixture(options: { anchor?: boolean; connected?: boolean } = {}) {
  const scroll = window.document.createElement('div');
  window.document.body.append(scroll);
  const anchor = window.document.createElement('div');
  anchor.dataset.navigationId = navigationId('t', 'u');
  if (options.anchor !== false) scroll.append(anchor);
  let height = 1000,
    documentY = 100;
  Object.defineProperty(scroll, 'scrollHeight', { get: () => height });
  scroll.scrollTop = 150;
  scroll.getBoundingClientRect = () => ({ top: 10 }) as any;
  anchor.getBoundingClientRect = () => ({ top: documentY - scroll.scrollTop + 10 }) as any;
  const jumps: string[] = [];
  const errors: unknown[] = [];
  const deps = {
    scroll: scroll as any,
    load: async () => {
      documentY += 300;
      height += 900;
    },
    afterPaint: async () => {},
    isCurrent: () => true,
    target: () => null as string | null,
    navigate: (id: string) => jumps.push(id),
    onError: (e: unknown) => errors.push(e),
  };
  return { scroll, anchor, deps, jumps, errors, close: () => scroll.remove() };
}

test('history restores message position without including live output growth', async () => {
  const f = historyFixture();
  try {
    await loadHistoryPage(f.deps);
    assert.equal(f.scroll.scrollTop, 450);
  } finally {
    f.close();
  }
});

test('a more recent jump wins over pagination restoration', async () => {
  const f = historyFixture();
  try {
    f.deps.target = () => f.anchor.dataset.navigationId!;
    await loadHistoryPage(f.deps);
    assert.deepEqual(f.jumps, [f.anchor.dataset.navigationId]);
    assert.equal(f.scroll.scrollTop, 150);
  } finally {
    f.close();
  }
});

test('missing destinations or removed anchors safely fall back to position restoration', async () => {
  const f = historyFixture();
  try {
    f.deps.target = () => 'missing';
    await loadHistoryPage(f.deps);
    assert.equal(f.scroll.scrollTop, 450);
  } finally {
    f.close();
  }
  for (const hasAnchor of [true, false]) {
    const f = historyFixture({ anchor: hasAnchor });
    try {
      const load = f.deps.load;
      f.deps.load = async () => {
        await load();
        f.anchor.remove();
      };
      await loadHistoryPage(f.deps);
      assert.equal(f.scroll.scrollTop, 1050);
    } finally {
      f.close();
    }
  }
});

test('obsolete requests cannot scroll another chat or surface its load error', async () => {
  const f = historyFixture();
  try {
    f.deps.isCurrent = () => false;
    await loadHistoryPage(f.deps);
    assert.equal(f.scroll.scrollTop, 150);
    f.deps.load = async () => {
      throw Error('old');
    };
    await loadHistoryPage(f.deps);
    assert.deepEqual(f.errors, []);
  } finally {
    f.close();
  }
});

test('load failures are reported for retry and never change the scroll position', async () => {
  const f = historyFixture();
  try {
    const error = Error('offline');
    f.deps.load = async () => {
      throw error;
    };
    await loadHistoryPage(f.deps);
    assert.deepEqual(f.errors, [error]);
    assert.equal(f.scroll.scrollTop, 150);
  } finally {
    f.close();
  }
});

test('anchor lookup is scoped and handles punctuation in stable IDs', () => {
  const f = historyFixture();
  try {
    assert.equal(navigationAnchor(f.scroll as any, f.anchor.dataset.navigationId!), f.anchor);
    assert.equal(navigationAnchor(window.document.createElement('div') as any, f.anchor.dataset.navigationId!), null);
  } finally {
    f.close();
  }
});

test('bookmark toggles retain other chats, preserve immutability and remove empty chat entries', async () => {
  const { toggleMessageBookmark } = await import('../src/lib/navigationBookmarks.ts');
  const original = { other: ['saved'] };
  const first = toggleMessageBookmark(original, 'c', 'first');
  assert.deepEqual(original, { other: ['saved'] });
  assert.deepEqual(first, { other: ['saved'], c: ['first'] });
  const second = toggleMessageBookmark(first, 'c', 'second');
  assert.deepEqual(toggleMessageBookmark(second, 'c', 'first'), { other: ['saved'], c: ['second'] });
  assert.deepEqual(toggleMessageBookmark(first, 'c', 'first'), original);
});

test('follow-ups without a separate answer omit the excerpt across harness turn IDs', () => {
  for (const id of ['codex-turn', 'ct-12345678-1234-1234-1234-123456789abc', 'acp-turn']) {
    const items = navigationItems([turn([user('u1', 'First'), user('u2', 'Second'), reply('Final answer')], 'completed', { id })]);
    assert.deepEqual(
      items.map((item) => item.response),
      ['', 'Final answer'],
    );
    assert.deepEqual(
      items.map((item) => item.prompt),
      ['First', 'Second'],
    );
  }
});

test("the browser's scroll anchoring is off while a page goes in, for every load in flight, and back after", async () => {
  // A page prepended above the reader moves what the browser anchors on; it would scroll by the page's height and
  // this restoration by as much again, a page too far.
  const f = historyFixture();
  try {
    const during: string[] = [];
    let release!: () => void;
    const load = f.deps.load;
    f.deps.load = async () => {
      during.push(f.scroll.style.overflowAnchor);
      await new Promise<void>((r) => (release = r));
      await load();
    };
    const first = loadHistoryPage(f.deps);
    await Promise.resolve();
    // another chat's load in the same transcript starts before the first one settles, and ends first
    const second = loadHistoryPage({ ...f.deps, load: async () => {}, isCurrent: () => false });
    await second;
    assert.equal(f.scroll.style.overflowAnchor, 'none');
    release();
    await first;
    assert.deepEqual(during, ['none']);
    assert.equal(f.scroll.style.overflowAnchor, '');
    assert.equal(f.scroll.scrollTop, 450);
    // a failed page turns it back on too
    f.deps.load = async () => {
      throw Error('offline');
    };
    await loadHistoryPage(f.deps);
    assert.equal(f.scroll.style.overflowAnchor, '');
  } finally {
    f.close();
  }
});

test('a navigation entry names the turn it belongs to', () => {
  const a = { ...turn([user('u1', 'First'), reply('One'), user('u2', 'Second')]), id: 'a' };
  const b = { ...turn([user('u3', 'Third')]), id: 'b' };
  const [first, second, third] = navigationItems([a, b]);
  assert.equal(navigationTurn([a, b], first.id), 'a');
  assert.equal(navigationTurn([a, b], second.id), 'a');
  assert.equal(navigationTurn([a, b], third.id), 'b');
  assert.equal(navigationTurn([a, b], 'missing'), null);
  assert.equal(navigationTurn([], first.id), null);
});
