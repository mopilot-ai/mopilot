// The composer's menus and bars (src/components/composer/ComposerMenus.tsx, ComposerBars.tsx): the new-chat context bar, the + panel
// with its plugins, the sketch pad, the permission picker, the Full access banner and the voice bar. A basic harness's
// mode picker is in composerModePicker.test.ts.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, fire, mouse } from './support/composer-kit.ts';
import { drawn, fx, last, mountComposer, permissionIcon, reset, settle, setVoice, store } from './support/composer-setup.ts';

beforeEach(() => reset());
const W = window as any;
const key = (k: string) => fire(window, new W.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const item = (title: string) => $$('.add-panel-item').find((x) => x.querySelector('.add-panel-title')!.textContent === title)!;
const menuItem = (text: string) => $$('.menu-item').find((x) => x.textContent!.includes(text))!;
const label = (text: string) => $$('.menu-section-label').find((x) => x.textContent === text);

test('context bar: project button, the branch + worktree chip for the project folder, and the project menu', async () => {
  const m = await mountComposer({ threadId: null });
  try {
    assert.equal($('.ctxbar .ctx-btn').getAttribute('aria-label'), 'Work in a project');
    assert.ok(!$('.stub-worktree') && !$('.stub-worktree-hint'));
    assert.ok(!$('[aria-label="Work in"]'));
    await click($('.ctxbar .ctx-btn'));
    await click($('.stub-project-menu'));
    assert.ok(!$('.stub-project-menu'));
    fx.project = { name: 'Proj', path: '/w/proj' };
    await m.rerender();
    assert.equal($('.ctxbar .ctx-btn span').textContent, 'Proj');
    assert.equal($('.stub-worktree-hint + .ctxbar .stub-worktree').textContent, '/w/proj', 'the suggestion sits just above the bar');
    // a workspace picked for this folder: the chat runs on its branch, so the branch + worktree chip goes
    assert.equal($('.ctxbar .stub-workspace').textContent, '/w/proj');
    store.set({ newChatWorkspace: { root: '/w/proj', path: '/c/tokyo', name: 'tokyo' } });
    await m.rerender();
    assert.ok($('.ctxbar .stub-workspace') && !$('.stub-worktree') && !$('.stub-worktree-hint'));
  } finally {
    await m.unmount();
  }
});

test('context bar: Cloud environments load once, can be picked, and fall back to this computer', async () => {
  fx.caps.cloud = 'native';
  fx.project = { name: 'Proj' };
  store.set({ newChatHost: { id: 'box', path: '/work' } });
  let loads = 0;
  let resolveEnvs!: (v: any) => void;
  fx.envs = () => (
    loads++,
    new Promise((r) => {
      resolveEnvs = r;
    })
  );
  const m = await mountComposer({ threadId: null });
  try {
    const env = () => $('[aria-label="Work in"]');
    assert.equal(env().textContent, 'This computer');
    await click(env());
    await mouse(menuItem('Cloud'), 'mousemove');
    assert.ok(label('Loading environments…'));
    resolveEnvs({
      envs: [
        { id: 'e1', label: 'Env one' },
        { id: 'e2', label: 'Env two' },
      ],
    });
    await settle();
    await click(menuItem('Env two'));
    assert.deepEqual(last('setState'), ['setState', { newChatHost: null, newChatCloudEnv: { id: 'e2', label: 'Env two' } }]);
    assert.equal(env().textContent, 'Env two');
    assert.ok(!$('.stub-worktree') && !$('.stub-worktree-hint'), 'no worktree in the cloud');
    await click(env());
    await mouse(menuItem('Cloud'), 'mousemove');
    assert.ok(menuItem('Env two').querySelector('.menu-check svg'));
    await click(menuItem('Manage environments'));
    assert.deepEqual(last('openLink'), ['openLink', 'https://chatgpt.com/codex/settings/environments']);
    await click(env());
    await click(menuItem('This computer'));
    assert.deepEqual(last('setState'), ['setState', { newChatCloudEnv: null }]);
    assert.equal(loads, 1);
  } finally {
    await m.unmount();
  }
});

test('context bar: no environments, or an error, is said in the menu', async () => {
  fx.caps.cloud = 'native';
  fx.envs = async () => ({ error: 'Sign in to ChatGPT' });
  const m = await mountComposer({ threadId: null });
  try {
    await click($('[aria-label="Work in"]'));
    await settle();
    await mouse(menuItem('Cloud'), 'mousemove');
    assert.ok(label('Sign in to ChatGPT'));
  } finally {
    await m.unmount();
  }
  fx.envs = async () => ({ envs: [] });
  const m2 = await mountComposer({ threadId: null });
  try {
    await click($('[aria-label="Work in"]'));
    await settle();
    await mouse(menuItem('Cloud'), 'mousemove');
    assert.ok(label('No cloud environments'));
  } finally {
    await m2.unmount();
  }
  // a request that failed says why, as an error main answers does
  fx.envs = async () => {
    throw new Error("Error invoking remote method 'cloud:envs': Error: offline");
  };
  const m3 = await mountComposer({ threadId: null });
  try {
    await click($('[aria-label="Work in"]'));
    await settle();
    await mouse(menuItem('Cloud'), 'mousemove');
    assert.ok(label('offline'));
  } finally {
    await m3.unmount();
  }
});

test('+ panel: files, project, goal, plan and sketch, by mouse and keyboard', async () => {
  const m = await mountComposer({ threadId: null });
  try {
    await click($('[aria-label="Add files and more"]'));
    assert.deepEqual(
      $$('.add-panel-title').map((x) => x.textContent),
      ['Files and folders', 'Work in a project', 'Goal', 'Plan mode', 'Computer History', 'Record a skill', 'Sketch'],
    );
    await click(item('Files and folders'));
    await settle();
    assert.deepEqual(
      $$('.attachment-name').map((x) => x.textContent),
      ['b.txt'],
    );
    assert.equal($('.attachment img').getAttribute('alt'), 'a.png');
    assert.ok(!$('.add-panel'), 'picking closes the panel');
    await click($('[aria-label="Add files and more"]'));
    await mouse(item('Goal'), 'mousemove');
    assert.match(item('Goal').className, /sel/);
    await click(item('Goal'));
    // Goal turns on goal mode (a chip) instead of typing /goal
    assert.equal(m.text, '');
    assert.ok($('.goal-chip'), 'goal mode is on');
    await click($('.goal-chip'));
    assert.ok(!$('.goal-chip'), 'cleared');
    await click($('[aria-label="Add files and more"]'));
    assert.equal(item('Plan mode').querySelector('.add-panel-desc')!.textContent, 'Turn plan mode on');
    await key('ArrowUp');
    await key('ArrowDown');
    await key('ArrowDown');
    await key('ArrowDown');
    // an input method's Enter confirms its candidate in the composer; it doesn't pick a row
    await fire(window, new W.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    // a held Enter doesn't pick either
    await fire(window, new W.KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true }));
    assert.ok(!$('.plan-chip'));
    assert.ok($('.add-panel'));
    // Cmd+Enter picks too, rather than sending under the open panel
    await fire(window, new W.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
    assert.ok($('.plan-chip'));
    await click($('[aria-label="Add files and more"]'));
    assert.ok(item('Plan mode').querySelector('.add-panel-check'));
    assert.equal(item('Plan mode').querySelector('.add-panel-desc')!.textContent, 'Turn plan mode off');
    for (let i = 0; i < 9; i++) await key('ArrowDown');
    assert.match(item('Sketch').className, /sel/);
    await key('x');
    await fire(document.body, new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.ok(!$('.add-panel'));
    await click($('[aria-label="Add files and more"]'));
    await key('ArrowDown');
    await key('Enter');
    assert.ok($('.stub-project-menu'));
    await click($('.stub-project-menu'));
    await click($('[aria-label="Add files and more"]'));
    await click(item('Sketch'));
    assert.ok($('.sketch'));
    await click($('.sketch-foot .btn-pill'));
  } finally {
    await m.unmount();
  }
});

test('+ panel: in a chat, "Message another chat" opens that chat\'s compose dialog with no recipient chosen', async () => {
  const composing: any[] = [];
  const onCompose = (e: any) => composing.push(e.detail);
  window.addEventListener('mopilot:peer-compose', onCompose);
  const m = await mountComposer({ threadId: 't1' });
  try {
    await click($('[aria-label="Add files and more"]'));
    assert.equal($$('.add-panel-title').at(-1)!.textContent, 'Message another chat');
    await click(item('Message another chat'));
    assert.deepEqual(composing, [{ sourceChatId: 't1', targetChatId: '' }]);
    assert.ok(!$('.add-panel'), 'picking closes the panel');
  } finally {
    await m.unmount();
    window.removeEventListener('mopilot:peer-compose', onCompose);
  }
});

test('+ panel: Goal is greyed where goals are off, for mouse and keyboard', async () => {
  fx.goalOff = 'Temporary chats have no goal';
  const m = await mountComposer({ threadId: 't1' });
  try {
    await click($('[aria-label="Add files and more"]'));
    const goal = item('Goal');
    assert.equal(goal.getAttribute('aria-disabled'), 'true');
    assert.equal(goal.title, 'Temporary chats have no goal');
    assert.equal(goal.querySelector('.add-panel-desc')!.textContent, 'Temporary chats have no goal');
    await click(goal);
    assert.ok($('.add-panel'));
    await key('ArrowDown');
    await key('ArrowDown');
    await key('Enter');
    assert.ok($('.add-panel'));
    assert.equal(m.text, '');
  } finally {
    await m.unmount();
  }
});

test('+ panel: installed Codex plugins, ChatGPT apps first, without bundled or duplicate ones', async () => {
  const p = (id: string, name: string, extra: any = {}) => ({ id, name, installed: true, ...extra });
  const bundled = p('b1', 'bundled-one');
  fx.plugins = async () => ({
    marketplaces: [
      {
        name: 'community',
        plugins: [
          p('c1', 'git_hub-tools'),
          p('c2', 'off', { enabled: false }),
          p('c3', 'default', { installPolicy: 'INSTALLED_BY_DEFAULT' }),
          p('c4', 'nope', { installed: false }),
        ],
      },
      {
        name: 'openai-curated-remote',
        plugins: [p('a1', 'slack', { interface: { displayName: 'Slack', shortDescription: 'Chat' } }), p('a2', 'git_hub-tools')],
      },
      { name: 'openai-bundled', plugins: [bundled] },
      { name: 'empty' },
    ],
  });
  const m = await mountComposer({ threadId: null });
  try {
    await click($('[aria-label="Add files and more"]'));
    await settle();
    assert.deepEqual(
      $$('.add-panel-title')
        .slice(7)
        .map((x) => x.textContent),
      ['Slack', 'Git Hub Tools'],
    );
    assert.deepEqual(
      $$('.add-panel-label').map((x) => x.textContent),
      ['Add', 'Plugins'],
    );
    assert.equal(item('Slack').querySelector('.add-panel-desc')!.textContent, 'Chat');
    assert.equal(item('Git Hub Tools').querySelector('.stub-logo')!.textContent, 'a2');
    await click(item('Slack'));
    assert.deepEqual(
      $$('.attachment-name').map((x) => x.textContent),
      ['slack'],
    );
  } finally {
    await m.unmount();
  }
  // no marketplaces at all, a failed listing, and another harness list nothing
  fx.plugins = async () => ({});
  const m2 = await mountComposer({ threadId: null });
  try {
    await click($('[aria-label="Add files and more"]'));
    await settle();
    assert.equal($$('.add-panel-item').length, 7, 'the built-in items only');
  } finally {
    await m2.unmount();
  }
  fx.plugins = async () => {
    throw new Error('offline');
  };
  const m3 = await mountComposer({ threadId: null });
  try {
    await click($('[aria-label="Add files and more"]'));
    await settle();
    assert.equal($$('.add-panel-item').length, 7, 'the built-in items only');
    // a failed listing says so, rather than looking like no plugins are installed
    assert.equal($('.add-panel-error').textContent, "Couldn't list your plugins: offline");
  } finally {
    await m3.unmount();
  }
  // an answer for a panel that was closed meanwhile is dropped, whether a list or a failure
  for (const fails of [false, true]) {
    let answer!: () => void;
    fx.plugins = () =>
      new Promise((ok, no) => {
        answer = () =>
          fails ? no(new Error('late')) : ok({ marketplaces: [{ name: 'm', plugins: [{ id: 'p@m', name: 'late', installed: true }] }] });
      });
    const m5 = await mountComposer({ threadId: null });
    try {
      await click($('[aria-label="Add files and more"]'));
      await click($('[aria-label="Add files and more"]'));
      await settle();
      answer();
      await settle();
      await click($('[aria-label="Add files and more"]'));
      assert.equal($$('.add-panel-item').length, 7, 'nothing from the closed panel');
      assert.equal($('.add-panel-error'), null);
    } finally {
      await m5.unmount();
    }
  }
  store.set({ newHarness: 'claude' });
  fx.plugins = async () => assert.fail('Codex plugins listed for Claude');
  const m4 = await mountComposer({ threadId: null });
  try {
    await click($('[aria-label="Add files and more"]'));
    await settle();
    assert.equal($$('.add-panel-item').length, 7, 'the built-in items only');
  } finally {
    await m4.unmount();
  }
});

test('sketch: draw in colours, erase wider, clear, and insert the drawing as an image', async () => {
  fx.saved = '/tmp/sketch.png';
  const m = await mountComposer({ threadId: null });
  try {
    await fire(window, new W.Event('open-sketch'));
    const canvas = $('.sketch-canvas') as any;
    assert.deepEqual(drawn[0].slice(0, 5), ['fillRect', 0, 0, 1200, 760]);
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 380, right: 600, bottom: 380 });
    // moving without pressing draws nothing
    await fire(canvas, new W.PointerEvent('pointermove', { bubbles: true, clientX: 5, clientY: 5 }));
    assert.equal(drawn.length, 1);
    await click($('[aria-label="Color #e5534b"]'));
    assert.match($('[aria-label="Color #e5534b"]').className, /on/);
    await fire(canvas, new W.PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 20, pointerId: 1 }));
    await fire(canvas, new W.PointerEvent('pointermove', { bubbles: true, clientX: 30, clientY: 40 }));
    await fire(canvas, new W.PointerEvent('pointerup', { bubbles: true }));
    await fire(canvas, new W.PointerEvent('pointermove', { bubbles: true, clientX: 50, clientY: 50 }));
    const strokes = drawn.filter((d) => d[0] === 'lineTo');
    assert.deepEqual(
      strokes.map((s) => s.slice(1, 3)),
      [
        [20, 40],
        [60, 80],
      ],
    );
    assert.deepEqual([strokes[0][3].strokeStyle, strokes[0][3].lineWidth], ['#e5534b', 3]);
    const range = $('[aria-label="Stroke width"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, 'value')!.set!;
    await fire(
      range,
      (() => {
        setter.call(range, '5');
        return new W.Event('input', { bubbles: true });
      })(),
    );
    await click($('[aria-label="Eraser"]'));
    assert.match($('[aria-label="Eraser"]').className, /on/);
    await fire(canvas, new W.PointerEvent('pointerdown', { bubbles: true, clientX: 1, clientY: 1 }));
    assert.deepEqual([drawn.at(-1)[1].strokeStyle, drawn.at(-1)[1].lineWidth], ['#ffffff', 30]);
    await click($$('.sketch-tool').find((b) => b.textContent === 'Clear'));
    assert.deepEqual(drawn.at(-1).slice(0, 5), ['fillRect', 0, 0, 1200, 760]);
    // a press inside the pad keeps it; Insert attaches and closes
    await mouse($('.sketch'), 'mousedown');
    assert.ok($('.sketch'));
    await click($('.sketch-foot .btn-white'));
    await settle();
    assert.ok(!$('.sketch'));
    assert.equal($('.attachment img').getAttribute('alt'), 'sketch.png');
    // a failed save just closes; Cancel and a press on the backdrop close too
    fx.saved = null;
    await fire(window, new W.Event('open-sketch'));
    await click($('.sketch-foot .btn-white'));
    await settle();
    assert.ok(!$('.sketch'));
    assert.equal($$('.attachment').length, 1);
    await fire(window, new W.Event('open-sketch'));
    await click($('.sketch-foot .btn-pill'));
    assert.ok(!$('.sketch'));
    await fire(window, new W.Event('open-sketch'));
    await mouse($('.sketch-backdrop'), 'mousedown');
    assert.ok(!$('.sketch'));
  } finally {
    await m.unmount();
  }
});

test('the project menu can be opened from anywhere', async () => {
  const m = await mountComposer({ threadId: null });
  try {
    await fire(window, new W.Event('open-project-menu'));
    assert.ok($('.stub-project-menu'));
  } finally {
    await m.unmount();
  }
});

test('the permission slot draws nothing while neither a first-tier nor a basic harness is resolved, and the composer stays up', async () => {
  // the frame between a switch to a basic harness and the store catching up: the family reads 'acp' (no first-tier id) while the chat has no basic id yet
  store.set({ harnessOf: { t1: 'acp' }, basicOf: { t1: null } });
  const m = await mountComposer({ threadId: 't1' });
  try {
    assert.ok($('.composer-editor'), 'the composer is drawn, not the chat error page');
    assert.ok(!$('[aria-label="Change permissions"]'));
    assert.ok(!$('[aria-label="Change mode"]'));
    store.set({ harnessOf: { t1: 'claude' } });
    await m.rerender();
    assert.ok($('[aria-label="Change permissions"]'), 'the picker comes back once a first-tier harness resolves');
  } finally {
    await m.unmount();
  }
});

test('permission icons differ by mode', async () => {
  const names = ['full-access', 'auto-review', 'read-only', 'default'].map(
    (mode) => (permissionIcon as any)(mode).type.displayName ?? (permissionIcon as any)(mode).type.name ?? 'x',
  );
  assert.equal(new Set(names).size, 4);
  assert.equal((permissionIcon as any)('default').props.size, 16);
});

test('voice bar keeps readable errors and dismisses without a cross-harness install action', async () => {
  const fixed: string[] = [];
  fx.codexFix = { label: 'Install Codex', run: () => fixed.push('fix') };
  await setVoice({ phase: 'connecting', threadId: 't1' });
  const m = await mountComposer({ threadId: 't1' });
  try {
    const status = () => $('.voice-status').textContent;
    assert.equal(status(), 'Connecting…');
    assert.equal($('.voice-wave i').style.transform, 'scaleY(0.25)');
    await setVoice({ phase: 'listening', level: 0.5, caption: { role: 'user', text: 'hi there' } });
    assert.equal(status(), 'Listening');
    assert.equal($('.voice-caption.user').textContent, 'hi there');
    assert.equal($$('.voice-wave i')[2].style.transform, 'scaleY(1)');
    await setVoice({ phase: 'speaking', level: 0 });
    assert.equal(status(), 'Speaking');
    assert.equal($$('.voice-wave i')[0].style.transform, 'scaleY(0.25)');
    await click($('[aria-label="Mute"]'));
    assert.ok(last('toggleMute'));
    await setVoice({ muted: true });
    assert.equal(status(), 'Muted');
    assert.ok($('[aria-label="Unmute"]'));
    await setVoice({ phase: 'error', error: 'Voice chat needs Codex.' });
    assert.equal(status(), 'Voice chat needs Codex.');
    assert.ok(!$('.voice-caption'));
    assert.ok(!$('.voice-bar .btn.primary'));
    assert.deepEqual(fixed, []);
    await click($('.voice-bar .btn-pill'));
    assert.ok(last('dismissVoice'));
    await setVoice({ error: null });
    assert.equal(status(), 'Voice unavailable');
    assert.ok(!$('.voice-bar .btn.primary'));
    fx.codexFix = { label: null };
    await setVoice({ error: 'Voice chat needs Codex.' });
    assert.ok(!$('.voice-bar .btn.primary'));
  } finally {
    await m.unmount();
  }
});

test('Full access banner: shown in chats with full access; Learn more, never again, or dismissed for the session', async () => {
  store.set((s: any) => ({ prefs: { ...s.prefs, permission: 'full-access' } }));
  const m = await mountComposer({ threadId: 't1' });
  try {
    assert.match($('.fa-text').textContent!, /^Full access is onCodex can edit any file/);
    // a real link (Tab reaches it), opened in the browser
    assert.equal($('.fa-text a')!.getAttribute('href'), 'https://developers.openai.com/codex/security');
    await click($('.fa-text a'));
    assert.deepEqual(last('openLink'), ['openLink', 'https://developers.openai.com/codex/security']);
    await click($('.fa-dont'));
    assert.deepEqual(last('prefs'), ['prefs', { hideFullAccessBanner: true }]);
    assert.ok(!$('.fa-banner'));
    store.set((s: any) => ({ prefs: { ...s.prefs, hideFullAccessBanner: false } }));
    await m.rerender();
    await click($('.fa-banner [aria-label="Dismiss"]'));
    assert.ok(!$('.fa-banner'));
  } finally {
    await m.unmount();
  }
  // dismissed stays dismissed for this session
  const m2 = await mountComposer({ threadId: 't1' });
  try {
    assert.ok(!$('.fa-banner'));
  } finally {
    await m2.unmount();
  }
});
