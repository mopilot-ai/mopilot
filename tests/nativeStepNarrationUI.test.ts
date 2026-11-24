// Vendor-native browser and computer steps in the thread (src/components/thread/Items.tsx): Claude in
// Chrome and Codex cua_repl calls read as what they did with their screenshot, consecutive control steps
// fold into one "Used the browser · N steps" run, and a native program expands to its code. Rendered for
// real with happy-dom; the rest of the component's imports are stubbed.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
// Side-effect import: installs the happy-dom globals (a named, unused import gets stripped by lint fixes).
import './support/dom.ts';
import { useSyncExternalStore, createElement as h } from 'react';
import { iconStubs, mockSource, taggedIcon, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

(globalThis as any).requestAnimationFrame = (fn: Function) => {
  fn();
  return 1;
};

const fixture: any = {
  state: {},
  listeners: new Set<Function>(),
  calls: [] as any[],
  subscribe(fn: Function) {
    fixture.listeners.add(fn);
    return () => fixture.listeners.delete(fn);
  },
  update(patch: any) {
    fixture.state = { ...fixture.state, ...patch };
    for (const fn of fixture.listeners) fn();
  },
};

let retryError: Error | null = null;
const record =
  (name: string) =>
  (...a: any[]) => {
    fixture.calls.push([name, ...a]);
  };
// Items is real; the modules it draws with are stand-ins
mock.module('../src/lib/paths.ts', {
  namedExports: {
    absPath: (p: string) => p,
    fileName: (p: string) => p,
    relPath: (p: string) => p,
    basename: (p: string) => String(p).split('/').pop(),
  },
});
mock.module('../src/lib/platform.ts', { namedExports: { isWin: false } });
mock.module('../src/session/harness/skillPath.ts', { namedExports: { useSkillPath: () => null, useSkillFile: () => null } });
mock.module('../src/session/openSkill.ts', { namedExports: { openSkill: () => {}, openSkillClick: () => {} } });
mock.module('../src/session/open.ts', { namedExports: { openMessageLink: record('openMessageLink'), openLink: record('openLink') } });
mock.module('../src/components/ui/Presence.tsx', { namedExports: { Collapse: ({ open, children }: any) => (open ? children : null) } });
mock.module('../src/components/markdown/Markdown.tsx', {
  namedExports: {
    Markdown: ({ text }: any) => h('div', null, text),
    CodeBlock: ({ code, lang }: any) => h('pre', { 'data-lang': lang }, code),
  },
});
mock.module('../src/session/clipboard.ts', { namedExports: { copyText: () => {} } });
mock.module('../src/components/thread/arrival.tsx', { namedExports: { useSmoothText: (t: string) => t } });
mock.module('../src/components/thread/PlanCard.tsx', { namedExports: { PlanCard: () => null } });
mock.module('../src/components/tasks/TaskEventCard.tsx', { namedExports: { TaskEventCard: () => null } });
mock.module('../src/components/tasks/SessionsCount.tsx', { namedExports: { InlineCounts: () => null, StatusCounts: () => null } });
mock.module('../src/components/thread/ReviewCard.tsx', { namedExports: { ReviewCard: () => null } });
mock.module('../src/components/thread/ScheduledTaskCard.tsx', { namedExports: { ScheduledTaskCard: () => null } });
// These cases exercise native control steps only; linked-session cards have their own full UI matrix.
mock.module('../src/components/thread/TaskProposalCard.tsx', {
  namedExports: { TaskProposalCard: () => null, TurnSuggestions: () => null },
});
mock.module('../src/components/thread/RunningCommand.tsx', {
  namedExports: { RunningCommand: ({ label, children }: any) => h('div', { className: 'running' }, label, children) },
});
mock.module('../src/components/thread/ClaudeActivity.tsx', {
  namedExports: {
    ClaudeActivity: ({ label, children }: any) => h('div', { className: 'claude-activity' }, label, children),
  },
});
mock.module('../src/components/ui/ImageLightbox.tsx', {
  namedExports: { ZoomableImage: (p: any) => h('img', { className: p.className, src: p.src, alt: p.alt, title: p.title }) },
});
mock.module('../src/components/diff/DiffView.tsx', {
  namedExports: { fileChangeToDiff: (c: any) => ({ added: 1, removed: 0, path: c.path }), InlineDiff: () => null },
});
installNativeStub({
  fs: { readImageDataUrl: async () => null },
  codex: { restart: async () => record('restartCodex')() },
  availability: {
    retry: async () => {
      record('availabilityRetry')();
      if (retryError) throw retryError;
    },
  },
});
stubStore(
  {
    useStore: Object.assign((s: any) => s(useSyncExternalStore(fixture.subscribe, () => fixture.state)), { getState: () => fixture.state }),
    openSubThread: record('openSubThread'),
    navigate: record('navigate'),
    toggleTasksPane: record('toggleTasksPane'),
    // a problem note's Try again and Restart Codex
    sendMessage: async (...a: any[]) => record('sendMessage')(...a),
    connect: record('connect'),
    limitNoteAction: () => ({ label: 'Continue', run: () => {} }),
    toastFailure: (what: string) => (e: Error) => record('toastFailure')(what, e.message),
    // the thread's session card (TaskProposalCard) imports these
    sendOrDraft: record('sendOrDraft'),
    toast: record('toast'),
  },
  {
    'src/store/panes.ts': { openAgentPage: record('openAgentPage') },
  },
);
mock.module('../src/harness/codexTranslate.ts', { namedExports: { compactionLabel: () => '', spawnedThreads: () => [] } });
mockSource('src/components/ui/icons.tsx', iconStubs(taggedIcon));
const react = await import('react');
const { act, createElement } = react;
const { createRoot } = await import('react-dom/client');
const Items = {
  ...(await import('../src/components/thread/Items.tsx')),
  ...(await import('../src/components/thread/items/stepModel.ts')),
  ...(await import('../src/components/thread/items/presentation.tsx')),
  ...(await import('../src/components/thread/items/StepGroups.tsx')),
  ...(await import('../src/components/thread/items/StepRow.tsx')),
};

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
const js = (code: string, o: any = {}) => call('js', { code, title: o.title }, { server: 'cua_repl', ...o });
const chrome = (tool: string, args: any = {}, o: any = {}) => call(tool, args, { server: 'claude-in-chrome', ...o });
const thought = (text: string) => ({ id: `r-${Math.random()}`, type: 'reasoning', summary: [text], content: [] });
const command = () => ({
  id: `c-${Math.random()}`,
  type: 'commandExecution',
  command: 'ls',
  status: 'completed',
  commandActions: [],
  exitCode: 0,
});
const tool = (item: any) => ({ kind: 'tool', item });
async function fresh(el: any) {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  return render(el);
}
const texts = (el: Element, sel: string) => [...el.querySelectorAll(sel)].map((e) => e.textContent);

test('StepRow: a Claude in Chrome step reads as what it did, with its screenshot and the browser icon', async () => {
  const el = await render(
    createElement(Items.StepRow, { step: tool(chrome('computer', { action: 'screenshot' }, { shots: ['a', 'b'] })) as any, cwd: '/w' }),
  );
  assert.equal(el.querySelector('.step-text')!.textContent, 'Took a screenshot');
  assert.equal(el.querySelector('.step-thumb')!.getAttribute('src'), PNG('b'));
  assert.equal(el.querySelector('.step-icon [data-icon]')!.getAttribute('data-icon'), 'Globe');
  await act(async () => el.querySelector<HTMLElement>('.step-row-hit, button.step-row')!.click());
  // its input stays JSON
  assert.equal(el.querySelector('.shell-scroll pre')!.getAttribute('data-lang'), 'json');
  assert.equal(el.querySelectorAll('.tool-screenshot').length, 2);
  // a call that sent no arguments shows an empty object
  const bare = { ...chrome('read_page'), arguments: undefined };
  const el2 = await fresh(createElement(Items.StepRow, { step: tool(bare) as any, cwd: '/w' }));
  await act(async () => el2.querySelector<HTMLElement>('.step-row-hit, button.step-row')!.click());
  assert.equal(el2.querySelector('.shell-scroll pre')!.textContent, '{}');
});

test('StepRow: a Codex cua_repl program reads as what it did, and expands to the code it ran', async () => {
  const code = "await tab.playwright.getByRole('button', { name: 'Submit' }).click();";
  const el = await render(createElement(Items.StepRow, { step: tool(js(code, { shots: ['shot'] })) as any, cwd: '/w' }));
  assert.equal(el.querySelector('.step-text')!.textContent, 'Clicked “Submit”');
  assert.equal(el.querySelector('.step-thumb')!.getAttribute('src'), PNG('shot'));
  await act(async () => el.querySelector<HTMLElement>('.step-row-hit, button.step-row')!.click());
  const pre = el.querySelector('.shell-scroll pre')!;
  assert.equal(pre.getAttribute('data-lang'), 'javascript');
  assert.equal(pre.textContent, code);
});

test("StepRow: a Codex step Codex Computer Use refused shows its message, then MoPilot's fix one click away", async () => {
  fixture.calls = [];
  const code = "const app = await cua.getApp('Notes'); await app.click({ x: 1, y: 2 });";
  const el = await render(
    createElement(Items.StepRow, {
      step: tool({ ...js(code), status: 'failed', result: null, error: { message: 'Computer Use permissions are not granted' } }) as any,
      cwd: '/w',
    }),
  );
  assert.equal(el.querySelector('.step-text')!.textContent, 'Clicked in Notes · Computer Use permissions are not granted');
  assert.ok(el.querySelector('.step')!.classList.contains('failed'));
  await act(async () => el.querySelector<HTMLElement>('.step-row-hit, button.step-row')!.click());
  const note = el.querySelector('.sky-problem')!;
  assert.deepEqual(
    [note.getAttribute('role'), note.getAttribute('data-kind'), note.getAttribute('data-code')],
    ['alert', 'permissions', '-10009'],
  );
  assert.deepEqual(texts(note, 'div'), [
    'Codex Computer Use needs permission',
    'Computer Use permissions are not granted',
    'In System Settings → Privacy & Security, turn on “Codex Computer Use” under Accessibility and Screen & System Audio Recording, then try again. Already on? It may still belong to an older copy of Codex Computer Use: in both lists, select Codex Computer Use, remove it with −, add it again with +, then try again.',
    'Open Accessibility settingsOpen Screen Recording settingsTry again',
  ]);
  // the tool's own output stays below
  assert.ok(el.querySelector('.shell-box'));
  await act(async () => [...note.querySelectorAll('button')][1].click());
  assert.deepEqual(fixture.calls, [['openLink', 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture']]);
  // a version mismatch points to the Computer use settings
  fixture.calls = [];
  const el2 = await fresh(
    createElement(Items.StepRow, {
      step: tool({ ...js('x'), status: 'failed', error: { message: 'Sky Computer Use API version mismatch: client=a server=b' } }) as any,
      cwd: '/w',
    }),
  );
  await act(async () => el2.querySelector<HTMLElement>('.step-row-hit, button.step-row')!.click());
  assert.equal(el2.querySelector('.sky-problem-title')!.textContent, 'Codex Computer Use needs an update');
  await act(async () => el2.querySelector<HTMLElement>('.sky-problem button')!.click());
  assert.deepEqual(fixture.calls, [['navigate', { name: 'settings', section: 'computer' }]]);
  // an unknown Sky code: raw code and message, the generic next step and no fix to offer; the step counts as failed though it completed
  const el3 = await fresh(
    createElement(Items.StepRow, {
      step: tool(js('x', { text: '{"name":"SkyComputerUseError","code":-10042,"message":"Something new"}' })) as any,
      cwd: '/w',
    }),
  );
  assert.equal(
    el3.querySelector('.step-text')!.textContent,
    'Ran a computer-use script · Codex Computer Use error (-10042): Something new',
  );
  assert.ok(el3.querySelector('.step')!.classList.contains('failed'));
  await act(async () => el3.querySelector<HTMLElement>('.step-row-hit, button.step-row')!.click());
  assert.equal(el3.querySelector('.sky-problem')!.getAttribute('data-code'), '-10042');
  assert.equal(
    el3.querySelector('.sky-problem-hint')!.textContent,
    'Try again. If it stops again, bring another tab or app to the front, or do this step yourself.',
  );
  assert.equal(el3.querySelector('.sky-problem-actions'), null);
  // a refusal Sky sends without a code: its own words, no code attribute
  const refusal = "Computer Use is not allowed to use the app 'com.1password.1password' for safety reasons.";
  const el5 = await fresh(
    createElement(Items.StepRow, { step: tool({ ...js('x'), status: 'failed', error: { message: refusal } }) as any, cwd: '/w' }),
  );
  await act(async () => el5.querySelector<HTMLElement>('.step-row-hit, button.step-row')!.click());
  assert.equal(el5.querySelector('.sky-problem')!.hasAttribute('data-code'), false);
  assert.equal(el5.querySelector('.sky-problem-message')!.textContent, refusal);
  // and a run counts it among its failures
  const el4 = await fresh(
    createElement(Items.ControlRun, {
      steps: [tool(js('x', { text: '{"errorName":"screenLocked"}' })) as any, tool(js("await tab.goto('https://a.test')")) as any],
      cwd: '/w',
    }),
  );
  assert.equal(el4.querySelector('.step-row.summary .step-text')!.textContent, 'Ran a computer-use script (1 failed), opened a.test');
  // a request to relaunch ChatGPT reads in MoPilot's words, and Try again checks computer use again
  fixture.calls = [];
  const el6 = await fresh(
    createElement(Items.StepRow, {
      step: tool({ ...js('x'), status: 'failed', error: { message: 'Sky Computer Use host service failed. Relaunch ChatGPT.' } }) as any,
      cwd: '/w',
    }),
  );
  await act(async () => el6.querySelector<HTMLElement>('.step-row-hit, button.step-row')!.click());
  assert.equal(
    el6.querySelector('.sky-problem-message')!.textContent,
    'Sky Computer Use host service failed. Try again in MoPilot. If it keeps failing, check Settings → Computer use.',
  );
  const buttons = [...el6.querySelectorAll<HTMLElement>('.sky-problem button')];
  assert.deepEqual(
    buttons.map((b) => b.textContent),
    ['Try again', 'Computer use settings'],
  );
  await act(async () => buttons[0].click());
  assert.deepEqual(fixture.calls, [['availabilityRetry']]);
  // a check that can't run says why instead of doing nothing
  fixture.calls = [];
  retryError = new Error('helper gone');
  try {
    await act(async () => buttons[0].click());
  } finally {
    retryError = null;
  }
  assert.deepEqual(fixture.calls, [['availabilityRetry'], ['toastFailure', "Couldn't check again", 'helper gone']]);
});

test('a problem note in a chat: Try again asks its agent to run the step again; Restart Codex restarts and reconnects', async () => {
  const { AgentChatContext } = await import('../src/components/agents/AgentChatContext.ts');
  const { SkyProblemNote } = await import('../src/components/thread/items/output.tsx');
  const { skyProblem, hostProblem } = await import('../shared/skyComputerUse.mjs');
  const inChat = (problem: any) =>
    fresh(createElement(AgentChatContext.Provider, { value: 'chat-1' }, createElement(SkyProblemNote, { problem })));
  fixture.calls = [];
  const locked = await inChat(skyProblem('{"errorName":"screenLocked"}')!);
  await act(async () => locked.querySelector<HTMLElement>('.sky-problem button')!.click());
  assert.deepEqual(fixture.calls, [['sendMessage', 'chat-1', 'Try that step again.']]);
  fixture.calls = [];
  const held = await inChat(hostProblem('cleanupBlocked', 'not released'));
  await act(async () => held.querySelector<HTMLElement>('.sky-problem button')!.click());
  assert.deepEqual(fixture.calls, [['restartCodex'], ['connect']]);
});

test('StepGroup: a group that is all control is one run that says what it did, replayable step by step', async () => {
  fixture.state = { prefs: { showReasoning: true } };
  const items = [
    js("let tab = await cua.createBrowserTab('chrome', 'https://shop.test')", { shots: ['one'] }),
    thought('Next I fill the form'),
    js("await tab.playwright.getByLabel('A').fill('1'); await tab.playwright.getByLabel('B').fill('2')"),
    chrome('computer', { action: 'left_click', ref: 'ref_1' }, { text: 'on ref_1 "Pay"', shots: ['two', 'three'] }),
  ];
  const el = await render(createElement(Items.StepGroup, { items: items as any, cwd: '/w', active: false }));
  const summary = el.querySelector('.control-run > .step-row.summary')!;
  // a program's step keeps its own words; a known action reads as Claude Desktop's verb
  assert.equal(summary.querySelector('.step-text')!.textContent, 'Opened shop.test, filled 2 fields, clicked');
  // each call's latest screenshot
  assert.deepEqual(
    [...summary.querySelectorAll('.step-thumb')].map((i) => i.getAttribute('src')),
    [PNG('one'), PNG('three')],
  );
  assert.equal(summary.querySelector('.step-icon [data-icon]')!.getAttribute('data-icon'), 'Globe');
  // not wrapped in another group summary
  assert.equal(el.querySelectorAll('.step-row.summary').length, 1);
  assert.equal(el.querySelector('.control-filmstrip'), null);
  await act(async () => summary.querySelector<HTMLElement>('.step-row-hit')!.click());
  assert.ok(el.querySelector('.control-run.open'));
  // every screenshot in order, labelled by its step
  const frames = [...el.querySelectorAll('.control-filmstrip .control-frame')];
  assert.deepEqual(
    frames.map((f) => f.getAttribute('src')),
    [PNG('one'), PNG('three')],
  );
  assert.deepEqual(
    frames.map((f) => f.getAttribute('title')),
    ['1. Opened shop.test', '2. Clicked “Pay”'],
  );
  assert.equal(frames[1].getAttribute('alt'), 'Step 2: Clicked “Pay”');
  assert.deepEqual(texts(el, '.step-list > .step .step-text'), ['Opened shop.test', 'Thought', 'Filled 2 fields', 'Clicked “Pay”']);
  await act(async () => summary.querySelector<HTMLElement>('.step-row-hit')!.click());
  assert.equal(el.querySelector('.step-list'), null);
});

test("StepGroup: control runs inside a mixed group, with earlier programs' bindings, failures and both surfaces", async () => {
  fixture.state = { prefs: { showReasoning: true } };
  const items = [
    command(),
    js('let notes = await cua.getApp("Notes")'),
    js('await notes.click(3)', { status: 'failed' }),
    js("await notes.type('hello')", { shots: ['n'] }),
    thought('done with Notes'),
    call('search', {}, { server: 'docs' }),
    js('await notes.pressKey("cmd+s")'),
    command(),
    thought('a thought before a run is not part of it'),
    chrome('navigate', { url: 'https://a.test' }),
    js("await tab.goto('https://b.test')", { status: 'declined' }),
    call('desktop_type', { text: 'x' }),
  ];
  const el = await render(createElement(Items.StepGroup, { items: items as any, cwd: '/w', active: false }));
  const outer = el.querySelector('.step-group > .step-row.summary')!;
  // past four phrases the rest fold, with the failure the turn did not get past
  assert.equal(
    outer.querySelector('.step-text')!.textContent,
    'Ran 2 commands, opened Notes, clicked in Notes, and 6 more actions, 1 failed',
  );
  assert.equal(outer.querySelector('.step-thumb')!.getAttribute('src'), PNG('n'));
  await act(async () => outer.querySelector<HTMLElement>('.step-row-hit')!.click());
  const runs = [...el.querySelectorAll('.step-list > .control-run')];
  assert.equal(runs.length, 2);
  // the failed click was followed by desktop steps that worked: not counted as failed
  // a run in one app names it once, at the end
  assert.equal(runs[0].querySelector('.step-row.summary .step-text')!.textContent, 'Opened Notes, clicked, typed 5 characters in Notes');
  assert.equal(runs[0].querySelector('.step-icon [data-icon]')!.getAttribute('data-icon'), 'MousePointerClick');
  assert.equal(runs[1].querySelector('.step-row.summary .step-text')!.textContent, 'Opened, opened b.test (1 failed), typed');
  assert.equal(runs[1].querySelector('.step-icon [data-icon]')!.getAttribute('data-icon'), 'Globe');
  assert.equal(runs[1].querySelector('.step-thumb'), null);
  // thoughts after or before a run stand on their own; so does a lone control step
  const list = el.querySelector('.step-list')!;
  assert.deepEqual(
    [...list.children].filter((x) => !x.classList.contains('control-run')).map((x) => x.querySelector('.step-text')!.textContent),
    ['Ran ls', 'Thought', 'Called docs search', 'Pressed ⌘S in Notes', 'Ran ls', 'Thought'],
  );
  await act(async () => runs[0].querySelector<HTMLElement>('.step-row.summary > .step-row-hit')!.click());
  // the earlier program bound notes to Notes: the next ones name it; a single screenshot needs no strip
  assert.deepEqual(texts(runs[0], '.step-list .step-text'), ['Opened Notes', 'Clicked · Retried another way', 'Typed 5 characters']);
  assert.equal(runs[0].querySelectorAll('.step-list .step.failed').length, 0);
  assert.equal(runs[0].querySelectorAll('.step-list .step.recovered').length, 1);
  assert.equal(runs[0].querySelector('.control-filmstrip'), null);
});

test('controlRuns and stepControl: what folds into a run, and narration worked out once per group', () => {
  const { controlRuns, stepControl, narrateSteps, itemSteps } = Items;
  const c = (s: string) => tool(js(`await tab.goto('${s}')`));
  const r = { kind: 'reasoning', item: thought('t') };
  const other = tool(call('search', {}, { server: 'docs' }));
  assert.deepEqual(
    controlRuns([r as any, c('a.test') as any, r as any]).map((x: any) => x.kind),
    ['step', 'step', 'step'],
  );
  assert.deepEqual(
    controlRuns([c('a.test') as any, c('b.test') as any]).map((x: any) => x.kind),
    ['control'],
  );
  assert.deepEqual(
    controlRuns([c('a.test') as any, other as any, c('b.test') as any, r as any, c('c.test') as any, r as any]).map((x: any) => [
      x.kind,
      x.steps?.length ?? 1,
    ]),
    [
      ['step', 1],
      ['step', 1],
      ['control', 3],
      ['step', 1],
    ],
  );
  assert.equal(stepControl(undefined), null);
  assert.equal(stepControl(r as any), null);
  assert.equal(stepControl(other as any), null);
  assert.equal(stepControl(c('a.test') as any)!.done, 'Opened a.test');
  // a narration worked out for the group wins, even when it is none
  assert.equal(stepControl({ ...c('a.test'), control: null } as any), null);
  const items = [js('let app = await cua.getApp("Mail")'), js('await app.click(1)'), command()];
  const steps = narrateSteps(items.flatMap(itemSteps as any), items as any);
  assert.deepEqual(
    steps.map((s: any) => s.control?.done ?? s.kind),
    ['Opened Mail', 'Clicked in Mail', 'command'],
  );
});

test('running: the native step says what it is doing, in both activity styles', async () => {
  fixture.state = { prefs: { showReasoning: true } };
  const running = js('await app.click(2)', { status: 'inProgress' });
  const items = [js('let app = await cua.getApp("Calendar")'), running];
  let el = await render(createElement(Items.StepGroup, { items, cwd: '/w', active: true, ux: 'dots' }));
  assert.equal(el.querySelector('.claude-activity')!.textContent, 'Clicking in Calendar');
  el = await fresh(createElement(Items.StepGroup, { items, cwd: '/w', active: true }));
  assert.equal(el.querySelector('.shimmer')!.textContent, 'Clicking in Calendar');
  assert.equal(Items.activeStepLabel(tool(chrome('find', { query: 'Pricing' })) as any), 'Looking for “Pricing”');
});

test('a run in one app leads with its icon once main names it; a run across apps reads "Used your computer"', async () => {
  fixture.state = { prefs: { showReasoning: true } };
  const { resetAppNames } = await import('../src/lib/appNames.ts');
  // the bridge names apps from here on (src/lib/appNames.ts reads it through the port)
  installNativeStub({
    computer: { appIdentity: async (app: string) => ({ name: app.includes('.') ? 'Thing' : app, bundleId: null, icon: 'data:icon' }) },
  });
  resetAppNames();
  const one = [js('let notes = await cua.getApp("Notes")'), js('await notes.pressKey("cmd+s")', { status: 'failed' })];
  const el = await render(createElement(Items.StepGroup, { items: one as any, cwd: '/w', active: false }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(el.querySelector('img.step-app-icon')?.getAttribute('src'), 'data:icon');
  // opened: plain rows (Claude Design 2A), no icon on any of them, a failed one included
  await act(async () => el.querySelector<HTMLElement>('.control-run .step-row.summary > .step-row-hit')!.click());
  assert.equal(el.querySelectorAll('.control-run .step-list .step-icon').length, 0);
  const two = [
    js('let notes = await cua.getApp("Notes")'),
    js('await notes.pressKey("cmd+s")'),
    js('let m = await cua.getApp("Mail")'),
    js('await m.click(1)'),
  ];
  const el2 = await render(createElement(Items.StepGroup, { items: two as any, cwd: '/w', active: false }));
  assert.equal(
    el2.querySelector('.control-run .step-text')!.textContent,
    'Opened Notes, pressed ⌘S in Notes, opened Mail, clicked in Mail',
  );
  // a bundle id narrates as "App" until main names it; the row re-narrates with the name
  const el3 = await render(
    createElement(Items.StepGroup, { items: [js('let t = await cua.getApp("com.example.thing")')] as any, cwd: '/w', active: false }),
  );
  assert.match(el3.textContent!, /Opened Thing/);
  (globalThis as any).window.native = undefined;
  resetAppNames();
});
