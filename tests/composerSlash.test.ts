// The composer's "/" menu entries (useSlashItems in src/components/composer/ComposerSlash.tsx): Sage's own entries
// and their submenus, Codex skills, a harness's command catalog, and a basic harness's commands.
import { test, beforeEach } from 'node:test';
import { act } from 'react';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, fire, mouse } from './support/composer-kit.ts';
import { all, dragEvent, events, fx, last, mountComposer, reset, settle, setSessionState, store } from './support/composer-setup.ts';
import { defined } from './support/defined.ts';
beforeEach(() => reset());
const W = window as any;
const titles = () => $$('.slash-panel .add-panel-title').map((x) => x.textContent);
const row = (title: string) => $$('.slash-panel .add-panel-item').find((x) => x.querySelector('.add-panel-title')!.textContent === title)!;
const desc = (title: string) => row(title).querySelector('.add-panel-desc')?.textContent;
async function pick(m: any, query: string, ...path: string[]) {
  await m.type('/' + query);
  for (const t of path) {
    await mouse(row(t), 'mousedown');
    await settle();
  }
}
const heard = (name: string) => {
  const seen: any[] = [];
  window.addEventListener(name, (e: any) => seen.push(e.detail ?? true));
  return seen;
};

test('slash entrypoint preserves the shared command array and execution helpers', async () => {
  const entry = await import('../src/components/composer/ComposerSlash.tsx');
  const actions = await import('../src/components/composer/ComposerCommands.ts');
  assert.equal(entry.SLASH_COMMANDS, actions.SLASH_COMMANDS);
  assert.equal(entry.blocked, actions.blocked);
  assert.equal(entry.runBang, actions.runBang);
});

test("Sage's entries in their order, each doing its thing", async () => {
  const feedback = heard('open-bug-report');
  const status = heard('open-status');
  const sketch = heard('open-sketch');
  const project = heard('open-project-menu');
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('/');
    assert.deepEqual(titles(), [
      'Chat',
      'Code review',
      'Fast',
      'Feedback',
      'Goal',
      'Init',
      'MCP',
      'Model',
      'Plan mode',
      'Reasoning',
      'Remote Control',
      'Sketch',
      'Status',
      'Accounts & billing',
      'Work in a project',
      'Worktree',
    ]);
    assert.equal(desc('Fast'), 'Codex fast');
    assert.equal(desc('Model'), 'Codex');
    assert.equal(desc('Reasoning'), 'High');
    assert.equal(desc('Worktree'), 'Turn worktree mode on');
    await pick(m, 'chat', 'Chat');
    assert.deepEqual([store.get().newChatProjectId, store.get().newChatCwd], ['none', null]);
    assert.deepEqual(last('navigate'), ['navigate', { name: 'home' }]);
    assert.equal(m.text, '');
    await pick(m, 'feed', 'Feedback');
    await pick(m, 'stat', 'Status');
    await pick(m, 'sket', 'Sketch');
    await pick(m, 'work', 'Work in a project');
    assert.deepEqual([feedback, status, sketch.length, project.length], [[{ threadId: 't1' }], ['t1'], 1, 1]);
    await pick(m, 'usage', 'Accounts & billing');
    assert.deepEqual(last('navigate'), ['navigate', { name: 'settings', section: 'accounts' }]);
    await pick(m, 'worktree', 'Worktree');
    assert.deepEqual([last('worktree'), store.get().prefs.worktreeDefault], [['worktree', true], true], 'the default for later chats too');
    await pick(m, 'goal', 'Goal');
    await settle(5);
    // Goal turns on goal mode (a chip) instead of typing /goal
    assert.equal(m.text, '');
    assert.ok($('.goal-chip'), 'goal mode is on');
    await click($('.goal-chip'));
    assert.ok(!$('.goal-chip'), 'cleared');
    await pick(m, 'init', 'Init');
    await settle();
    assert.equal(defined(last('send'))[2].length > 0, true);
    await pick(m, 'plan', 'Plan mode');
    assert.deepEqual(last('session'), ['session', 't1', { plan: true }]);
    await m.type('/plan');
    assert.equal(desc('Plan mode'), 'Turn plan mode off');
    await m.type('/worktree');
    assert.equal(desc('Worktree'), 'Turn worktree mode off');
  } finally {
    await m.unmount();
  }
});

test('Code review: uncommitted changes, or against the default branch when there is one', async () => {
  store.set({ threads: { t1: { cwd: '/proj' } } });
  const m = await mountComposer({ threadId: 't1' });
  try {
    await pick(m, 'code', 'Code review');
    assert.deepEqual(titles(), ['Review uncommitted changes', 'Review against main']);
    assert.deepEqual(last('git'), ['git', '/proj', ['rev-parse', '--abbrev-ref', 'origin/HEAD']]);
    await mouse(row('Review against main'), 'mousedown');
    await settle();
    assert.deepEqual(last('review'), ['review', 't1', { type: 'baseBranch', branch: 'main' }]);
    await pick(m, 'code', 'Code review', 'Review uncommitted changes');
    assert.deepEqual(last('review'), ['review', 't1', { type: 'uncommittedChanges' }]);
    fx.reviewFails = new Error('dirty');
    await pick(m, 'code', 'Code review', 'Review uncommitted changes');
    await pick(m, 'code', 'Code review', 'Review against main');
    fx.reviewFails = 'x';
    await pick(m, 'code', 'Code review', 'Review uncommitted changes');
    await pick(m, 'code', 'Code review', 'Review against main');
    assert.deepEqual(
      all('toast').map((e) => e[1]),
      ['dirty', 'dirty', 'x', 'x'],
    );
    fx.blocked.review = 'Needs newer';
    await pick(m, 'code', 'Code review', 'Review uncommitted changes');
    await pick(m, 'code', 'Code review', 'Review against main');
    assert.equal(all('review').length, 6);
    fx.gitBase = { ok: false };
    await pick(m, 'code', 'Code review');
    assert.deepEqual(titles(), ['Review uncommitted changes']);
  } finally {
    await m.unmount();
  }
});

test('Fast: toggles fast mode or the first tier; unavailable says why; several tiers become Speed', async () => {
  fx.fastNote = 'billed more';
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('/fast');
    assert.equal(desc('Fast'), 'Codex fast · billed more');
    await pick(m, 'fast', 'Fast');
    assert.deepEqual(last('selection'), ['selection', 'codex', { fast: true }, 't1']);
    fx.sel = { ...fx.sel, fast: true, tiers: [{ id: 'prio', name: 'Priority' }] };
    await pick(m, 'fast', 'Fast');
    assert.deepEqual(defined(last('selection'))[2], { tier: null });
    fx.sel = { ...fx.sel, fast: false };
    await pick(m, 'fast', 'Fast');
    assert.deepEqual(defined(last('selection'))[2], { tier: 'prio' });
    fx.sel = { ...fx.sel, fastUnavailable: 'Not on your plan' };
    await pick(m, 'fast', 'Fast');
    assert.deepEqual(last('toast'), ['toast', 'Not on your plan']);
    fx.sel = {
      ...fx.sel,
      fastUnavailable: null,
      fast: true,
      tiers: [
        { id: 'flex', name: 'Flex', description: 'Cheap' },
        { id: 'prio', name: 'Priority' },
      ],
      tier: 'flex',
    };
    fx.fastNote = null;
    await m.type('/fast');
    assert.equal(desc('Speed'), 'Flex');
    assert.ok(row('Speed').querySelector('.add-panel-check'));
    await pick(m, 'fast', 'Speed');
    assert.deepEqual(titles(), ['Standard', 'Flex', 'Priority']);
    assert.ok(row('Flex').querySelector('.add-panel-check'));
    await mouse(row('Standard'), 'mousedown');
    assert.deepEqual(defined(last('selection'))[2], { tier: null });
    fx.sel = { ...fx.sel, tier: 'gone' };
    await m.type('/fast');
    assert.equal(desc('Speed'), 'Standard');
  } finally {
    await m.unmount();
  }
  // Claude has no Fast description of its own
  store.set({ harnessOf: { t2: 'claude' } });
  fx.sel = { ...fx.sel, tiers: [], fastUnavailable: null };
  const m2 = await mountComposer({ threadId: 't2' });
  try {
    await m2.type('/f');
    assert.equal(desc('Fast'), undefined);
    assert.ok(titles().includes('Feedback'), "MoPilot's bug report is on every harness");
  } finally {
    await m2.unmount();
  }
});

test('MCP lists the servers of the harness the chat is on', async () => {
  const m = await mountComposer({ threadId: 't1' });
  try {
    await pick(m, 'mcp', 'MCP');
    assert.deepEqual(titles(), ['No MCP servers']);
    await mouse(row('No MCP servers'), 'mousedown');
    assert.deepEqual(last('navigate'), ['navigate', { name: 'settings', section: 'codex', tab: 'extensions:mcps' }]);
    fx.mcpRows = [{ name: 'github', desc: 'Running' }];
    await pick(m, 'mcp', 'MCP');
    assert.equal(desc('github'), 'Running');
    await mouse(row('github'), 'mousedown');
    assert.equal(all('navigate').length, 2);
    assert.deepEqual(last('mcpRows'), ['mcpRows', 'codex', 't1']);
    // a status read that failed is said, not shown as "No MCP servers"
    fx.mcpRows = new Error('app-server down');
    await pick(m, 'mcp', 'MCP');
    assert.ok(!titles().includes('No MCP servers'));
    assert.match(document.querySelector('.slash-panel [role="alert"]')?.textContent ?? '', /Could not load MCP: app-server down/);
  } finally {
    await m.unmount();
  }
});

test('Model and Reasoning list the choices and set them for this chat', async () => {
  const m = await mountComposer({ threadId: 't1' });
  try {
    await pick(m, 'model', 'Model');
    assert.deepEqual(titles(), ['M1', 'M2']);
    assert.ok(row('M1').querySelector('.add-panel-check'));
    assert.equal(desc('M2'), 'Second');
    await mouse(row('M2'), 'mousedown');
    assert.deepEqual(last('selection'), ['selection', 'codex', { model: 'm2', effort: 'low' }, 't1']);
    fx.sel = { ...fx.sel, effort: 'low' };
    await pick(m, 'model', 'Model', 'M2');
    assert.deepEqual(defined(last('selection'))[2], { model: 'm2', effort: 'low' });
    fx.sel = { ...fx.sel, effort: null };
    await pick(m, 'model', 'Model', 'M1');
    assert.deepEqual(defined(last('selection'))[2], { model: 'm1', effort: 'high' });
    fx.sel = { ...fx.sel, effort: 'high' };
    await pick(m, 'reas', 'Reasoning');
    assert.deepEqual(titles(), ['Low', 'High']);
    assert.ok(row('High').querySelector('.add-panel-check'));
    await mouse(row('Low'), 'mousedown');
    assert.deepEqual(defined(last('selection'))[2], { effort: 'low' });
  } finally {
    await m.unmount();
  }
});

test('Ultracode: shown once the session says, explains why it is off, toggles otherwise', async () => {
  setSessionState('t1', { ultracode: { probe: 'ok', available: true, on: false } });
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('/ultra');
    assert.equal(desc('Ultracode'), 'Multi-agent workflows for big tasks');
    await pick(m, 'ultra', 'Ultracode');
    assert.deepEqual(last('ultracode'), ['ultracode', 't1', true]);
    setSessionState('t1', { ultracode: { probe: 'ok', available: false, on: true } });
    await m.rerender();
    await m.type('/ultra');
    assert.equal(desc('Ultracode'), "This model can't run ultracode");
    assert.ok(row('Ultracode').querySelector('.add-panel-check'));
    await pick(m, 'ultra', 'Ultracode');
    setSessionState('t1', { ultracode: { probe: 'changed', available: true, on: false } });
    await m.rerender();
    await m.type('/ultra');
    assert.match(desc('Ultracode')!, /changed how ultracode works/);
    await pick(m, 'ultra', 'Ultracode');
    assert.deepEqual(
      all('toast').map((e) => e[1]),
      ["This model can't run ultracode", 'This Claude Code version changed how ultracode works · Update MoPilot'],
    );
    assert.equal(all('ultracode').length, 1);
  } finally {
    await m.unmount();
  }
  // a new chat has no session to ask
  const m2 = await mountComposer({ threadId: null });
  try {
    await m2.type('/ultra');
    assert.ok(!$('.slash-panel'));
  } finally {
    await m2.unmount();
  }
});

test('Goal is greyed where goals are off', async () => {
  fx.goalOff = 'No goals here';
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('/goal');
    assert.equal(row('Goal').getAttribute('aria-disabled'), 'true');
    assert.equal(desc('Goal'), 'No goals here');
  } finally {
    await m.unmount();
  }
});

test('Codex skills follow the commands, with their scope; picking one attaches it', async () => {
  let resolveSkills: (v: any) => void = () => {};
  fx.skills = (force: boolean) =>
    force
      ? new Promise((r) => {
          resolveSkills = r;
        })
      : Promise.resolve({
          skills: [
            { path: '/u/ship', name: 'ship-it', scope: 'user', description: 'Ship things' },
            { path: '/r/lint', name: 'team:lint_fix', scope: 'repo', interface: { displayName: 'Lint', shortDescription: 'Fix lint' } },
            { path: '/s/sys', name: 'sys', scope: 'system' },
            { path: '/o/other', name: 'other', scope: 'admin' },
          ],
        });
  store.set({ threads: { t1: { cwd: '/proj' } } });
  const m = await mountComposer({ threadId: 't1' });
  try {
    await settle();
    await m.type('/');
    const t = titles();
    assert.deepEqual(t.slice(-4), ['Lint', 'Other', 'Ship It', 'Sys']);
    assert.deepEqual(
      ['Lint', 'Other', 'Ship It', 'Sys'].map((x) => row(x).querySelector('.add-panel-scope')!.textContent),
      ['Project', 'admin', 'Personal', 'System'],
    );
    assert.deepEqual([desc('Lint'), desc('Ship It'), desc('Sys')], ['Fix lint', 'Ship things', undefined]);
    // the skill's own name matches too
    await m.type('/team');
    assert.deepEqual(titles(), ['Lint']);
    await mouse(row('Lint'), 'mousedown');
    await settle(5);
    assert.match(m.editor().textContent, /Lint/);
    assert.equal(m.text, '', 'the typed /query is replaced by the skill');
    await pick(m, 'ship', 'Ship It');
    await settle(5);
    assert.match(m.editor().textContent, /Ship It/);
    // a skills change reloads; a reload superseded by another is dropped
    await fire(window, new W.Event('skills-changed'));
    const first = resolveSkills;
    await fire(window, new W.Event('skills-changed'));
    first({ skills: [{ path: '/x', name: 'stale', scope: 'user' }] });
    resolveSkills({ skills: [] });
    await settle();
    await m.type('/');
    assert.ok(!titles().includes('Stale'));
    assert.deepEqual(
      events.filter((e) => e[0] === 'skills').map((e) => e.slice(1)),
      [
        ['/proj', false],
        ['/proj', true],
        ['/proj', true],
      ],
    );
  } finally {
    await m.unmount();
  }
});

test("Codex skills belong to the chat's folder: another chat's menu shows none of them, and a late answer is dropped", async () => {
  const answers: Record<string, (v: any) => void> = {};
  fx.skills = () =>
    new Promise((r) => {
      answers[events.filter((e) => e[0] === 'skills').at(-1)![1]] = r;
    });
  const skill = (name: string) => ({ skills: [{ path: `/${name}`, name, scope: 'repo' }] });
  store.set({ threads: { t1: { cwd: '/a' }, t2: { cwd: '/b' } } });
  const m = await mountComposer({ threadId: 't1' });
  try {
    await act(async () => answers['/a'](skill('alpha')));
    await settle();
    await m.type('/');
    assert.ok(titles().includes('Alpha'));
    // a reload for /a is still in flight when the user moves to the chat in /b
    await fire(window, new W.Event('skills-changed'));
    const lateA = answers['/a'];
    await m.rerender({ threadId: 't2' });
    await m.type('/');
    assert.ok(!titles().includes('Alpha'), "the first menu in /b shows none of /a's skills");
    await act(async () => lateA(skill('stale')));
    await act(async () => answers['/b'](skill('beta')));
    await settle();
    await m.type('/');
    assert.ok(titles().includes('Beta'));
    assert.ok(!titles().includes('Stale') && !titles().includes('Alpha'));
    assert.deepEqual(
      events.filter((e) => e[0] === 'skills').map((e) => e.slice(1)),
      [
        ['/a', false],
        ['/a', true],
        ['/b', false],
      ],
    );
  } finally {
    await m.unmount();
  }
});

test('a $ reference or an inline / opens a skills-only menu without the commands', async () => {
  fx.skills = () =>
    Promise.resolve({
      skills: [
        { path: '/u/ship', name: 'ship-it', scope: 'user' },
        { path: '/r/lint', name: 'lint', scope: 'repo' },
      ],
    });
  store.set({ threads: { t1: { cwd: '/proj' } } });
  const m = await mountComposer({ threadId: 't1' });
  try {
    await settle();
    await m.type('/');
    assert.ok(titles().length > 2, 'the start-of-prompt / menu has the commands too');
    await m.type('$');
    assert.deepEqual(titles(), ['Lint', 'Ship It']);
    await m.type('Use /sh');
    assert.deepEqual(titles(), ['Ship It']);
    await mouse(row('Ship It'), 'mousedown');
    await settle(5);
    assert.match(m.editor().textContent, /Ship It/);
  } finally {
    await m.unmount();
  }
});

test('skills: a failed listing shows none, a stale failure is dropped, and none load before Codex is ready', async () => {
  fx.skills = () => Promise.reject(new Error('no codex'));
  const m = await mountComposer({ threadId: null });
  try {
    await settle();
    await m.type('/s');
    assert.ok(!titles().some((t) => t === 'Ship It'));
    let reject: (e: any) => void = () => {};
    fx.skills = () =>
      new Promise((_, r) => {
        reject = r;
      });
    await fire(window, new W.Event('skills-changed'));
    const first = reject;
    await fire(window, new W.Event('skills-changed'));
    first(new Error('stale'));
    await settle();
  } finally {
    await m.unmount();
  }
  store.set({ conn: 'connecting' });
  const m2 = await mountComposer({ threadId: null });
  try {
    await settle();
    assert.equal(all('skills').length, 3);
  } finally {
    await m2.unmount();
  }
});

test("a basic harness's chat lists none of Codex's skills, even with Codex connected", async () => {
  fx.skills = async () => ({ skills: [{ path: '/s', name: 'ship-it', scope: 'repo' }] });
  store.set({ basicOf: { k1: 'kimi' }, threads: { k1: { cwd: '/proj' } } });
  const kimi = await mountComposer({ threadId: 'k1' });
  try {
    await settle();
    assert.equal(all('skills').length, 0, "Codex's skills/list is never asked for a basic harness's chat");
  } finally {
    await kimi.unmount();
  }
  // the same folder on Codex lists them
  store.set({ basicOf: {}, threads: { c1: { cwd: '/proj' } } });
  const codex = await mountComposer({ threadId: 'c1' });
  try {
    await settle();
    assert.deepEqual(
      all('skills').map((e) => e[1]),
      ['/proj'],
    );
  } finally {
    await codex.unmount();
  }
});

test("a harness's catalog: Sage keeps its own entries, adds App commands, then the harness's commands and skills", async () => {
  fx.nativeCmds = [{ name: 'compact' }];
  fx.provider = { label: 'Claude Code' };
  const menu = [
    { name: 'model', dispatch: 'passthrough', source: 'harness' },
    { name: 'mcp', dispatch: 'passthrough', source: 'harness', aliases: ['servers'] },
    { name: 'compact', dispatch: 'passthrough', source: 'harness', description: 'Compact it', aliases: ['squash', 'cram'] },
    { name: 'review-pr', dispatch: 'passthrough', source: 'skill', description: 'A skill' },
    { name: 'rename', dispatch: 'ui', source: 'app' },
  ];
  fx.registry = () => ({ menu, hidden: [] });
  fx.appEntries = (_menu: any, ids: Set<string>, names: Set<string>, noApp: Set<string>) => {
    assert.ok(ids.has('model') && !ids.has('mcp'), 'Sage keeps Model; the harness has its own MCP');
    assert.ok(names.has('rename') && noApp.has('goal'));
    return [
      { name: 'rename', description: 'Rename the chat', source: 'app', hint: true },
      { name: 'diff', description: 'Open changes', source: 'app' },
      { name: 'tasks', description: 'Show background tasks and agents', source: 'app' },
      { name: 'design-login', description: 'Authorize Claude Design for this account · by MoPilot', source: 'app' },
      { name: 'logout', source: 'harness', why: { layer: 'session', code: 'session.runningElsewhere' }, semantic: 'review' },
    ];
  };
  store.set({ harnessOf: { t1: 'claude' } });
  const design = heard('open-design-login');
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('/');
    const t = titles();
    assert.ok(t.includes('Model') && !t.includes('MCP'));
    assert.deepEqual(t.slice(-8), [
      '/rename',
      '/diff',
      '/tasks',
      '/design-login',
      '/logout',
      '/mcp (/servers)',
      '/compact (/squash, /cram)',
      '/review-pr',
    ]);
    assert.equal(row('/rename').querySelector('.add-panel-scope')!.textContent, 'App');
    assert.ok(!row('/logout').querySelector('.add-panel-scope'));
    assert.equal(row('/logout').getAttribute('aria-disabled'), 'true');
    assert.equal(row('/review-pr').querySelector('.add-panel-scope')!.textContent, 'Skill');
    assert.equal(desc('/compact (/squash, /cram)'), 'Compact it');
    await m.type('/squash');
    assert.deepEqual(titles(), ['/compact (/squash, /cram)']);
    await mouse(row('/compact (/squash, /cram)'), 'mousedown');
    await settle(5);
    assert.equal(m.text, '/compact ');
    await pick(m, 'rena', '/rename');
    await settle(5);
    assert.equal(m.text, '/rename ');
    await pick(m, 'diff', '/diff');
    assert.ok(last('openChanges'));
    await pick(m, 'tasks', '/tasks');
    assert.deepEqual(last('toggleTasksPane'), ['toggleTasksPane', 't1']);
    // Claude Design's sign-in opens for this chat
    await pick(m, 'design', '/design-login');
    assert.deepEqual(design, ['t1']);
    assert.equal(all('skills').length, 0, "Claude's catalog brings its own skills");
  } finally {
    await m.unmount();
  }
});

test('the "/" menu closes on Escape or a press outside it, leaving the typed text', async () => {
  const m = await mountComposer({ threadId: 't1' });
  try {
    for (const dismiss of [
      () => fire(document.body, new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      () => mouse(document.body, 'mousedown'),
    ]) {
      await m.type('/');
      assert.ok($('.slash-panel'));
      await dismiss();
      assert.equal($('.slash-panel'), null);
      assert.equal(m.text, '/');
    }
  } finally {
    await m.unmount();
  }
});

test('slash-menu failures report errors and recover only the unchanged original draft', async () => {
  for (const change of [
    'none',
    'sync',
    'plain-error',
    'null-error',
    'new-text',
    'new-attachment',
    'switch',
    'close',
    'away-text',
    'away-attachment',
    'missing',
  ]) {
    reset();
    const text = change === 'sync' ? '/fast' : '/init';
    const old = { kind: 'file', path: '/old.txt', name: 'old.txt' };
    store.set({ drafts: { t1: { text, attachments: [old] }, t2: { text: 'second draft', attachments: [] } } });
    let reject: (error: unknown) => void = () => {};
    const pending = new Promise((_resolve, fail) => {
      reject = fail;
    });
    fx.existsAnswer = () => pending;
    if (change === 'sync') fx.selectionFails = new Error('menu failed');
    const m = await mountComposer({ threadId: 't1' });
    let closed = false;
    try {
      await m.type(text);
      await mouse(row(change === 'sync' ? 'Fast' : 'Init'), 'mousedown');
      if (change === 'new-text') await m.type('new draft');
      else if (change === 'new-attachment') {
        fx.paths = { 'new.txt': '/new.txt' };
        const dt = new W.DataTransfer();
        dt.items.add(new W.File(['data'], 'new.txt', { type: 'text/plain' }));
        await fire($('.composer'), dragEvent('drop', dt));
      } else if (change === 'close') {
        await m.unmount();
        closed = true;
      } else if (['switch', 'away-text', 'away-attachment', 'missing'].includes(change)) {
        await m.rerender({ threadId: 't2' });
        await act(async () => {
          if (change === 'away-text') store.set((s: any) => ({ drafts: { ...s.drafts, t1: { text: 'new draft', attachments: [] } } }));
          if (change === 'away-attachment') store.set((s: any) => ({ drafts: { ...s.drafts, t1: { text: '', attachments: [] } } }));
          if (change === 'missing') store.set({ drafts: { t2: { text: 'second draft', attachments: [] } } });
        });
      }
      if (change !== 'sync')
        await act(async () => reject(change === 'plain-error' ? 'plain error' : change === 'null-error' ? null : new Error('menu failed')));
      await settle();
      assert.deepEqual(last('toast'), [
        'toast',
        change === 'plain-error' ? 'plain error' : change === 'null-error' ? 'null' : 'menu failed',
        'error',
      ]);
      if (['none', 'sync', 'plain-error', 'null-error'].includes(change)) assert.equal(m.text, text);
      if (change === 'new-text') assert.equal(m.text, 'new draft');
      if (change === 'new-attachment') {
        assert.equal(m.text, '');
        assert.deepEqual(
          $$('.attachment-name').map((x) => x.textContent),
          ['old.txt', 'new.txt'],
        );
      }
      if (['switch', 'away-text', 'away-attachment', 'missing'].includes(change)) assert.equal(m.text, 'second draft');
      if (['switch', 'close'].includes(change)) assert.equal(store.get().drafts.t1.text, text);
      if (change === 'away-text') assert.equal(store.get().drafts.t1.text, 'new draft');
      if (change === 'away-attachment') assert.deepEqual(store.get().drafts.t1.attachments, []);
      if (change === 'missing') assert.equal(store.get().drafts.t1, undefined);
    } finally {
      if (change !== 'sync') reject(new Error('cleanup'));
      if (!closed) await m.unmount();
    }
  }
});

test("a command picked from the menu whose message main didn't take puts the typed text back", async () => {
  fx.sendAnswer = async () => false;
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('/init');
    await mouse(row('Init'), 'mousedown');
    await settle();
    assert.equal(defined(last('send'))[1], 't1');
    assert.equal(m.text, '/init');
  } finally {
    await m.unmount();
  }
});
