import { test, mock } from 'node:test';
import { realPaths } from './support/composer-goal-modules.ts';
import assert from 'node:assert/strict';
import { importsToStubWithChatVisibility as importsToStub } from './support/source-modules.ts';
import { window } from './support/dom.ts';
import { defined } from './support/defined.ts';
import { f, cap } from './support/composer-goal-fakes.ts';

(globalThis as any).requestAnimationFrame = (fn: FrameRequestCallback) => {
  fn(0);
  return 1;
};
(globalThis as any).cancelAnimationFrame = () => {};
const React = await import('react');
const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');
// The real composer files run; every module they import from outside that set is mocked with the
// names they import, taken from the fixture (or inert).

for (const [file, names] of importsToStub(realPaths.map((p) => new URL('../' + p, import.meta.url))))
  mock.module(file, { namedExports: Object.fromEntries([...names].map((name) => [name, f[name] ?? (() => null)])) });
const { Composer } = await import('../src/components/composer/Composer.tsx');
const { composerGoalMessage, composerGoalReason } = await import('../src/harness/composerGoalMessage.ts');
const { useComposerDraft } = await import('../src/components/composer/useComposerDraft.ts');

async function mount(draft: any = {}, harness = 'codex', basic: string | null = null) {
  f.state = {
    drafts: { main: draft },
    chatConfig: {},
    runtime: {},
    prefs: { permission: 'default' },
    threads: { main: {}, side: {} },
    threadOrder: [],
    claudeArchived: {},
    segments: {},
    conn: 'idle',
  };
  f.session = { queue: [], tasks: [], queued: [], plan: false, acp: {}, runningElsewhere: false };
  f.cap = basic || harness === 'claude' ? { state: 'native', via: 'passthrough', template: '/goal {args}' } : cap;
  f.harness = harness;
  f.basic = basic;
  f.off = null;
  f.blocked = null;
  f.sent = [];
  f.notices = [];
  f.refs = [];
  f.refError = false;
  f.shell = true;
  f.provider = null;
  f.acpResult = null;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  let id: string | null = 'main';
  const render = async (next: string | null = id) => {
    id = next;
    await act(() => root.render(createElement(Composer, { threadId: id, variant: 'thread' })));
  };
  await render();
  const click = async (selector: string) => {
    const el = host.querySelector<HTMLElement>(selector);
    assert.ok(el, selector);
    await act(async () => {
      el.click();
      await Promise.resolve();
    });
  };
  const input = async (value: string) => {
    const el = host.querySelector('textarea')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
      el.dispatchEvent(new window.Event('input', { bubbles: true }) as any);
    });
  };
  const goal = async () => {
    await click('[aria-label="Add files and more"]');
    const row = [...host.querySelectorAll<HTMLElement>('.add-panel-item')].find((e) => e.textContent?.includes('Goal'));
    assert.ok(row);
    await act(async () => {
      row.click();
      await Promise.resolve();
    });
  };
  return {
    host,
    render,
    click,
    input,
    goal,
    close: async () => {
      await act(() => root.unmount());
      host.remove();
    },
  };
}

test('selecting and clearing Goal preserves the text and attachments, and restores per-chat drafts', async () => {
  const file = { kind: 'file', name: 'note', path: '/note' };
  const m = await mount({ text: 'test', attachments: [file] });
  try {
    assert.equal(m.host.querySelector('.goal-chip') === null, true);
    await m.goal();
    assert.equal(m.host.querySelector('.goal-chip')?.textContent, 'Goal');
    assert.equal(m.host.querySelector('.goal-chip')?.parentElement?.title, 'Clear goal');
    assert.equal(m.host.querySelector('textarea')?.value, 'test');
    await m.click('.goal-chip');
    assert.equal(m.host.querySelector('.goal-chip') === null, true);
    assert.equal(m.host.querySelector('textarea')?.value, 'test');
    await m.goal();
    await m.render('side');
    await m.render('main');
    assert.ok(m.host.querySelector('.goal-chip'));
    assert.equal(m.host.querySelector('textarea')?.value, 'test');
    // Codex sets a goal from its text only: with a file it isn't sent (the file would be dropped), and nothing is lost
    await m.click('[aria-label="Send"]');
    assert.deepEqual(f.sent, []);
    assert.match(String(f.notices.at(-1)?.[0]), /A goal is set from its text only/);
    assert.ok(m.host.querySelector('.goal-chip'));
    assert.equal(m.host.querySelector('textarea')?.value, 'test');
  } finally {
    await m.close();
  }
});

for (const [harness, basic] of [
  ['codex', null],
  ['claude', null],
  ['codex', 'kimi'],
] as const) {
  test(`${basic ?? harness}: slash selection submits a goal with references instead of interpreting its body as another command`, async () => {
    const m = await mount({}, harness, basic);
    try {
      await m.input('/go');
      const row = [...m.host.querySelectorAll<HTMLElement>('.slash-panel .add-panel-item')].find(
        (e) => e.textContent?.includes('Goal') || e.textContent?.includes('/goal'),
      );
      assert.ok(row, m.host.innerHTML);
      await act(async () => {
        row.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }) as any);
      });
      assert.ok(m.host.querySelector('.goal-chip'));
      assert.equal(m.host.querySelector('textarea')?.value, '');
      assert.equal(m.host.querySelector('[aria-label="Send"]') === null, true);
      await m.input('/clear\nkeep working');
      f.refs = [{ kind: 'session', name: 'Related chat', path: 'chat:other' }];
      await m.click('[aria-label="Send"]');
      if (basic || harness === 'claude') {
        // the harness's own /goal command is a message: the chat reference goes with it
        assert.deepEqual(f.sent, [['main', '/goal /clear\nkeep working', f.refs, { human: true }]]);
        assert.equal(m.host.querySelector('.goal-chip') === null, true);
      } else {
        // Codex's goal API takes the objective only: a goal with a chat reference isn't sent, rather than drop it
        assert.deepEqual(f.sent, []);
        assert.match(String(f.notices.at(-1)?.[0]), /A goal is set from its text only/);
        assert.ok(m.host.querySelector('.goal-chip'));
      }
    } finally {
      await m.close();
    }
  });
}

test('/new (and its /clear alias) releases the chat it leaves, then opens a new chat', async () => {
  const m = await mount();
  const released: string[] = [];
  f.native.session.release = async (id: string) => {
    released.push(id);
    if (id === 'side') throw new Error('main is gone');
    return { claude: 1 };
  };
  f.navigated = [];
  try {
    await m.input('/new');
    await m.click('[aria-label="Send"]');
    assert.deepEqual(released, ['main']);
    assert.deepEqual(f.navigated, [{ name: 'home' }]);
    // a release that fails is not the user's problem: the new chat opens anyway
    await m.render('side');
    await m.input('/new');
    await m.click('[aria-label="Send"]');
    assert.deepEqual(released, ['main', 'side']);
    // from the new-chat screen there is no chat to release
    await m.render(null);
    await m.input('/new');
    await m.click('[aria-label="Send"]');
    assert.deepEqual(released, ['main', 'side']);
    assert.equal(f.navigated.length, 3);
    assert.equal(f.sent.length, 0);
  } finally {
    await m.close();
  }
});

test('unavailable goals, compatibility errors and reference failures preserve pending input', async () => {
  const m = await mount({ text: 'test', attachments: [] });
  try {
    f.blocked = 'Update the CLI';
    await m.goal();
    assert.equal(m.host.querySelector('.goal-chip') === null, true);
    assert.deepEqual(f.notices.at(-1), ['Update the CLI', 'error']);
    f.blocked = null;
    await m.goal();
    f.off = 'Temporary chats cannot have goals';
    await m.render();
    await m.click('[aria-label="Send"]');
    assert.equal(f.sent.length, 0);
    assert.equal(m.host.querySelector('textarea')?.value, 'test');
    assert.ok(m.host.querySelector('.goal-chip'));
    f.off = null;
    f.blocked = 'Update the CLI';
    await m.render();
    await m.click('[aria-label="Send"]');
    assert.equal(f.sent.length, 0);
    f.blocked = null;
    f.refError = true;
    await m.click('[aria-label="Send"]');
    assert.equal(f.sent.length, 0);
    assert.ok(m.host.querySelector('.goal-chip'));
    assert.equal(m.host.querySelector('textarea')?.value, 'test');
    f.refError = false;
    f.cap = { state: 'absent', via: 'none' };
    await m.render();
    await m.click('[aria-label="Send"]');
    assert.equal(f.sent.length, 0);
    assert.deepEqual(f.notices.at(-1), ['Goals are unavailable in this chat', 'error']);
    f.cap = cap;
    await m.render();
    await m.click('[aria-label="Send"]');
    assert.equal(f.sent.length, 1);
  } finally {
    await m.close();
  }
});

test('empty or whitespace goals cannot send attachments alone; clearing restores ordinary sending', async () => {
  const file = { kind: 'file', path: '/note', name: 'note' };
  const m = await mount({ text: '', attachments: [file], goal: true });
  try {
    assert.equal(m.host.querySelector('[aria-label="Send"]') === null, true);
    await m.input('   ');
    assert.equal(m.host.querySelector('[aria-label="Send"]') === null, true);
    await m.click('.goal-chip');
    await m.click('[aria-label="Send"]');
    assert.deepEqual(f.sent, [['main', '   ', [file], { plan: false, human: true }]]);
  } finally {
    await m.close();
  }
});

test('new chats restore the home Goal draft; an unavailable capability cannot select Goal from the menu', async () => {
  const m = await mount();
  try {
    f.state.drafts.home = { text: 'new goal', attachments: [], goal: true };
    await m.render(null);
    assert.ok(m.host.querySelector('.goal-chip'));
    await m.click('[aria-label="Send"]');
    assert.equal(f.sent[0][0], null);
    f.cap = { state: 'disabled', via: 'none', why: { code: 'flag.off.goal' } };
    await m.render('main');
    await m.goal();
    assert.equal(m.host.querySelector('.goal-chip') === null, true);
  } finally {
    await m.close();
  }
});

test('goal adapters preserve literal objectives; a text-only goal refuses attachments; unsupported bindings are refused', () => {
  const file: any = { kind: 'file', name: 'note', path: '/note' };
  for (const state of ['native', 'sage'] as const) {
    const rpc: any = { state, via: 'rpc' };
    assert.equal(composerGoalReason(rpc, null), null);
    assert.deepEqual(composerGoalMessage(rpc, '  clear\n$&  ', []), {
      text: 'clear\n$&',
      attachments: [],
      options: { goal: 'clear\n$&', human: true },
    });
    // the goal API takes the objective only: attachments would be dropped silently, so the goal isn't sent
    assert.throws(() => composerGoalMessage(rpc, 'clear', [file]), /A goal is set from its text only/);
    assert.equal(composerGoalReason(rpc, 'Temporary chat'), 'Temporary chat');
  }
  // a goal typed as the harness's own command is a message: its attachments go with it
  assert.deepEqual(composerGoalMessage({ state: 'native', via: 'passthrough', template: '/goal {args}' } as any, '$&\nfinish', [file]), {
    text: '/goal $&\nfinish',
    attachments: [file],
    options: { human: true },
  });
  for (const c of [
    { state: 'absent', via: 'none' },
    { state: 'disabled', via: 'rpc' },
    { state: 'route', via: 'route' },
    { state: 'native', via: 'passthrough' },
    { state: 'native', via: 'passthrough', template: '/goal' },
    { state: 'sage', via: 'polyfill' },
  ]) {
    assert.equal(composerGoalReason(c as any, null), 'Goals are unavailable in this chat');
    assert.throws(() => composerGoalMessage(c as any, 'test', []), /Goals are unavailable/);
  }
  assert.equal(
    composerGoalReason({ state: 'absent', via: 'none', why: { code: 'harness.undeclared' } } as any, null),
    'harness.undeclared',
  );
  assert.throws(() => composerGoalMessage(cap as any, '  ', []), /Enter a goal/);
});

test('draft persistence saves Goal toggles and keeps legacy drafts compatible', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const calls: any[] = [];
  const attachments: any[] = [];
  const save = (key: string, draft: any) => calls.push({ key, ...draft });
  function Probe({ id, text, items, goal }: any) {
    useComposerDraft(id, text, items, save, goal);
    return null;
  }
  const render = (id: string, text: string, items: any[] = attachments, goal?: boolean) =>
    act(() => root.render(createElement(Probe, { id, text, items, goal })));
  await render('main', 'text');
  await act(() => t.mock.timers.tick(200));
  assert.deepEqual(calls.pop(), { key: 'main', text: 'text', attachments });
  await render('main', 'text', attachments, true);
  await act(() => t.mock.timers.tick(200));
  assert.deepEqual(calls.pop(), { key: 'main', text: 'text', attachments, goal: true });
  const edited: any[] = [{ kind: 'file' }];
  await render('main', 'text', edited, true);
  assert.equal(calls.pop().goal, true);
  await render('main', 'pending', edited, false);
  await render('side', 'other', attachments, true);
  assert.deepEqual(calls.pop(), { key: 'main', text: 'pending', attachments: edited, goal: false });
  await act(() => root.unmount());
  host.remove();
  assert.deepEqual(calls.pop(), { key: 'side', text: 'other', attachments, goal: true });
});

test('a draft switch saves only typing still waiting for its pause, into the draft it was typed in', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const calls: any[] = [];
  const none: any[] = [];
  const save = (key: string, draft: any) => calls.push([key, draft.text]);
  function Probe({ id, text }: any) {
    useComposerDraft(id, text, none, save);
    return null;
  }
  const render = (id: string, text: string) => act(() => root.render(createElement(Probe, { id, text })));
  await render('a', 'typed in a');
  await act(() => t.mock.timers.tick(200));
  assert.deepEqual(calls.splice(0), [['a', 'typed in a']]);
  // already saved: leaving saves nothing again, and the next chat's first frame (still showing a's text) never
  // lands in its draft once the composer shows that chat's own text
  await render('b', 'typed in a');
  assert.deepEqual(calls, []);
  await render('b', 'b draft');
  await act(() => t.mock.timers.tick(200));
  assert.deepEqual(calls.splice(0), [['b', 'b draft']]);
  // typing still waiting is saved into its own chat at once when the chat changes
  await render('b', 'b draft, more');
  await render('c', 'b draft, more');
  assert.deepEqual(calls.splice(0), [['b', 'b draft, more']]);
  await render('c', 'c draft');
  await act(() => t.mock.timers.tick(200));
  assert.deepEqual(calls.splice(0), [['c', 'c draft']]);
  await act(() => root.unmount());
  host.remove();
  assert.deepEqual(calls, [], 'nothing was waiting when the editor closed');
});

test('clearing Goal on ACP restores ordinary prompts and other slash commands', async () => {
  const m = await mount({ text: 'plain', goal: true }, 'codex', 'kimi');
  try {
    await m.click('.goal-chip');
    await m.click('[aria-label="Send"]');
    assert.deepEqual(f.sent, [['main', 'plain', [], { plan: false, human: true }]]);
    await m.input('/he');
    const help = m.host.querySelector<HTMLElement>('.slash-panel .add-panel-item')!;
    await act(async () => help.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }) as any));
    assert.equal(m.host.querySelector('textarea')?.value, '/help ');
    assert.equal(m.host.querySelector('.goal-chip') === null, true);
    f.acpResult = { kind: 'unknown', note: 'Unknown command' };
    await m.click('[aria-label="Send"]');
    await m.click('.slash-note button');
    assert.equal(f.sent.at(-1)[1], '/help ');
  } finally {
    await m.close();
  }
});

test('clearing Goal leaves non-goal slash entries and send-as-plain-text available', async () => {
  const m = await mount({ text: 'goal', goal: true });
  try {
    await m.click('.goal-chip');
    f.provider = { label: 'Codex' };
    await m.render();
    await m.input('/cus');
    const custom = m.host.querySelector<HTMLElement>('.slash-panel .add-panel-item')!;
    await act(async () => custom.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }) as any));
    assert.equal(m.host.querySelector('textarea')?.value, '/custom ');
    assert.equal(m.host.querySelector('.goal-chip') === null, true);
    await m.input('/unknown');
    await m.click('[aria-label="Send"]');
    await m.click('.slash-note button');
    assert.equal(f.sent.at(-1)[1], '/unknown');
  } finally {
    await m.close();
  }
});

test('a selected goal follows the current binding after a harness switch', async () => {
  const m = await mount({ text: 'finish the task', attachments: [], goal: true });
  try {
    f.cap = { state: 'native', via: 'passthrough', template: '/goal {args}' };
    f.harness = 'claude';
    await m.render();
    await m.click('[aria-label="Send"]');
    assert.deepEqual(f.sent, [['main', '/goal finish the task', [], { human: true }]]);
    await m.input('finish again');
    await m.goal();
    f.cap = cap;
    f.harness = 'codex';
    await m.render();
    await m.click('[aria-label="Send"]');
    assert.deepEqual(f.sent.at(-1), ['main', 'finish again', [], { goal: 'finish again', human: true }]);
  } finally {
    await m.close();
  }
});

test("the @ menu puts the chat's browser tabs first; picking one by key or mouse inserts its tab token", async () => {
  const m = await mount({ text: '' });
  const tabs = [
    { key: 'app:t1', where: 'app', title: 'Preview', url: 'http://localhost:5173/', tabId: 't1', browserId: null },
    { key: 'chrome:9', where: 'chrome', title: 'Mail', url: 'https://mail.test/', tabId: '9', browserId: null },
  ];
  const seen: any[] = [];
  f.tabs = (threadId: string, query: string) => {
    seen.push([threadId, query]);
    return tabs;
  };
  f.tabRows = ({ tabs: rows, index, onPick }: any) =>
    rows.map((t: any, i: number) =>
      createElement('div', { key: t.key, className: `tab-row ${i === index ? 'kbd-active' : ''}`, onMouseDown: () => onPick(t) }, t.title),
    );
  try {
    const ta: any = m.host.querySelector('textarea')!;
    const replaced: any[] = [];
    ta.replaceRange = (start: number, end: number, text: string) => replaced.push([start, end, text]);
    await m.input('see @');
    assert.deepEqual(seen.at(-1), ['main', '']);
    assert.deepEqual(
      [...m.host.querySelectorAll('.tab-row')].map((r) => r.textContent),
      ['Preview', 'Mail'],
    );
    await act(async () => {
      ta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });
    await act(async () => {
      ta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    assert.deepEqual(replaced, [[4, ta.selectionStart, '<chrome:9> ']]);
    assert.equal(m.host.querySelector('.tab-row'), null);
    await m.input('see @Pre');
    assert.deepEqual(seen.at(-1), ['main', 'Pre']);
    await act(async () => m.host.querySelector('.tab-row')!.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }) as any));
    assert.deepEqual(replaced.at(-1), [4, ta.selectionStart, '<app:t1> ']);
    assert.equal(f.sent.length, 0);
    // chats and files follow the tabs in the keyboard order and keep their own rows for the mouse
    f.state.threads.c1 = { id: 'c1', title: 'Chat one', updatedAt: 1 };
    f.state.threadOrder = ['c1'];
    f.files = [{ path: 'src/a.ts', file_name: 'a.ts', indices: null }];
    await m.input('see @');
    await act(() => new Promise((r) => setTimeout(r, 120)));
    const rows = () => [...m.host.querySelectorAll('.menu-item')];
    assert.deepEqual(
      rows().map((r) => r.textContent),
      ['Chat one', 'a.tssrc/a.ts'],
    );
    await act(async () => {
      rows()[1].dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true }) as any);
    });
    assert.equal(rows()[1].classList.contains('kbd-active'), true);
    await act(async () => {
      rows()[0].dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true }) as any);
    });
    assert.equal(rows()[0].classList.contains('kbd-active'), true);
    await act(async () => {
      rows()[0].dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }) as any);
    });
    // the chat's token (sessionToken is stubbed here) replaces the typed @
    assert.deepEqual(replaced.length, 3);
    assert.equal(defined(replaced.at(-1))[0], 4);
    await m.input('see  @');
    await act(() => new Promise((r) => setTimeout(r, 120)));
    for (let i = 0; i < 3; i++)
      await act(async () => {
        ta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      });
    await act(async () => {
      ta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    // a file mention replaces the typed @ through the editor too
    assert.deepEqual(replaced.at(-1), [5, 6, '@src/a.ts ']);
    await m.input('see   @');
    await act(() => new Promise((r) => setTimeout(r, 120)));
    for (let i = 0; i < 2; i++)
      await act(async () => {
        ta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      });
    await act(async () => {
      ta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    assert.deepEqual(replaced.at(-1)?.[0], 6);
  } finally {
    delete f.tabs;
    delete f.tabRows;
    delete f.files;
    await m.close();
  }
});

test('a browser page-annotation chip shows as its screenshot, sends as image plus mark text, and removing it removes the attachment', async () => {
  const chip = {
    kind: 'image',
    path: '/tmp/annot.png',
    name: 'Annotations · shop.test',
    previewUrl: 'data:image/png;base64,QQ==',
    text: '[1] Region: too big',
    pageUrl: 'https://shop.test/',
  };
  const m = await mount({ text: 'fix these', attachments: [chip] });
  try {
    assert.equal(m.host.querySelector<HTMLImageElement>('.attachment.image img')?.getAttribute('alt'), 'Annotations · shop.test');
    await m.click('[aria-label="Send"]');
    assert.deepEqual(f.sent, [
      [
        'main',
        'fix these',
        [
          { kind: 'image', path: '/tmp/annot.png', name: 'Annotations · shop.test', previewUrl: 'data:image/png;base64,QQ==' },
          { kind: 'selection', path: '', name: 'Annotations · shop.test', text: '[1] Region: too big' },
        ],
        { plan: false, human: true },
      ],
    ]);
  } finally {
    await m.close();
  }
  const again = await mount({ text: 'fix these', attachments: [chip] });
  try {
    await again.click('.attachment.image .attachment-remove');
    assert.equal(again.host.querySelector('.attachment.image'), null);
    await again.click('[aria-label="Send"]');
    assert.deepEqual(f.sent, [['main', 'fix these', [], { plan: false, human: true }]]);
  } finally {
    await again.close();
  }
});
