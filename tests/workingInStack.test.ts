// The "working in" stack beside the composer, rendered against a fake store and session: cards per app on both paths, live thumbnails polled once a second, icons, end states, the opened live view and bring to front.
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, render, resetStore, setStore, trustedClick, native, settle } from './support/thread-kit.ts';

mockStore();
const { useSessions } = await import('../src/store/session/useSession.ts');
const { EMPTY_SESSION } = await import('../src/store/session/sessionState.ts');
const { WorkingInStack, THUMB_POLL_MS } = await import('../src/components/thread/WorkingIn.tsx');
const { resetAppNames } = await import('../src/lib/appNames.ts');
const { setDocked } = await import('../src/lib/docked.ts');

const T = 't1';
const result = (extra: any[] = []) => ({ content: extra });
const cua = (code: string, status = 'completed') => ({
  type: 'mcpToolCall',
  server: 'cua_repl',
  tool: 'js',
  arguments: { code },
  status,
  result: result(),
});
const sage = (tool: string, args: any, status = 'completed', extra: any[] = []) => ({
  type: 'mcpToolCall',
  server: 'sage_x',
  tool,
  arguments: args,
  status,
  result: result(extra),
});
const showTurn = (status: string, items: any[], id = 'turn1') =>
  setStore({ runtime: { [T]: { loaded: true, turns: [{ id, status, items }] } } });

let thumbs: any[] = [];
let thumbAnswer: any = { thumbnail: 'data:image/jpeg;base64,TElWRQ==', bundleId: 'com.apple.TextEdit' };
let iconAnswer: any = 'data:image/png;base64,SUNPTg==';
let fronted: any[] = [];
beforeEach(() => {
  resetStore();
  useSessions.setState({ sessions: {} });
  thumbs = [];
  fronted = [];
  thumbAnswer = { thumbnail: 'data:image/jpeg;base64,TElWRQ==', bundleId: 'com.apple.TextEdit' };
  iconAnswer = 'data:image/png;base64,SUNPTg==';
  resetAppNames();
  native.computer = {
    workingThumb: async (chatId: string, app: string, turnId?: string, size?: string) => {
      thumbs.push([chatId, app, turnId, size]);
      if (thumbAnswer instanceof Error) throw thumbAnswer;
      return thumbAnswer;
    },
    appIdentity: async (app: string) => {
      if (iconAnswer instanceof Error) throw iconAnswer;
      return { name: app, bundleId: null, icon: iconAnswer };
    },
    bringToFront: async (app: string, bundleId: string | null) => (fronted.push([app, bundleId]), true),
  };
});

test('nothing without a turn, or a turn that controls no desktop app', async () => {
  const v = await render(h(WorkingInStack, { threadId: T }));
  assert.equal(v.$('.working-in-stack'), null);
  await settle(() => showTurn('inProgress', [{ type: 'agentMessage', text: 'hi' }]));
  assert.equal(v.$('.working-in-stack'), null);
});

test('vendor path: the app a cua program works in, the step with Mac keys, a live thumbnail polled once a second, then a done check', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    showTurn('inProgress', [cua('let te = await cua.getApp("TextEdit")'), cua('await te.pressKey("super+n")', 'inProgress')]);
    const v = await render(h(WorkingInStack, { threadId: T }));
    await settle();
    const card = v.$('.working-in-card')!;
    assert.equal(card.dataset.status, 'working');
    assert.equal(card.dataset.path, 'vendor');
    assert.equal(v.$('.working-in-app')!.textContent, 'TextEdit');
    // the app's icon heads the name and the status heads the step, so both lines' text starts at one x
    assert.ok(v.$('.working-in-app > .working-in-app-icon:first-child'));
    assert.ok(v.$('.working-in-step > .working-in-badge:first-child'));
    assert.equal(v.$('.working-in-app .working-in-badge'), null);
    // the card names the app once: the step drops its "in TextEdit"
    assert.equal(v.$('.working-in-step')!.textContent, 'Pressing ⌘N');
    assert.equal(v.$('.working-in-main')!.getAttribute('aria-label'), 'Working in TextEdit: Pressing ⌘N');
    assert.equal(v.$('img.working-in-thumb')!.getAttribute('src'), 'data:image/jpeg;base64,TElWRQ==');
    assert.deepEqual(thumbs, [[T, 'TextEdit', 'turn1', 'card']]);
    await settle(() => mock.timers.tick(THUMB_POLL_MS));
    await settle(() => mock.timers.tick(THUMB_POLL_MS));
    assert.equal(thumbs.length, 3, 'one more a second while it works');
    // the turn ends: a check, the past tense, one last frame, and no more polling
    await settle(() => showTurn('completed', [cua('let te = await cua.getApp("TextEdit")'), cua('await te.pressKey("super+n")')]));
    assert.equal(v.$('.working-in-stack')!.dataset.status, 'done');
    assert.ok(v.$('.working-in-badge.ok'));
    assert.equal(v.$('.working-in-step')!.textContent, 'Pressed ⌘N');
    const after = thumbs.length;
    await settle(() => mock.timers.tick(THUMB_POLL_MS * 3));
    assert.equal(thumbs.length, after);
    // the arrow brings the app forward by the bundle id main found; an untrusted click does nothing
    v.$('.working-in-front')!.click();
    assert.deepEqual(fronted, []);
    await trustedClick(v.$('.working-in-front')!);
    assert.deepEqual(fronted, [['TextEdit', 'com.apple.TextEdit']]);
    // the next turn without desktop control: the stack goes
    await settle(() => showTurn('inProgress', [], 'turn2'));
    assert.equal(v.$('.working-in-stack'), null);
  } finally {
    mock.timers.reset();
  }
});

test('MoPilot path: the background strip’s live thumbnail and bundle id win; stopped and failed end states', async () => {
  useSessions.setState({
    sessions: {
      [T]: {
        ...EMPTY_SESSION,
        rev: 1,
        appControl: {
          apps: [
            {
              bundleId: 'com.apple.Notes',
              app: 'Notes',
              title: 'Doc',
              windowId: 3,
              thumbnail: 'data:image/jpeg;base64,U1RSSVA=',
              at: 1,
              takenOver: false,
            },
          ],
        },
      },
    },
  });
  thumbAnswer = { thumbnail: null, bundleId: null };
  showTurn('interrupted', [sage('desktop_app_click', { app: 'Notes' })]);
  const v = await render(h(WorkingInStack, { threadId: T }));
  await settle();
  assert.equal(v.$('.working-in-card')!.dataset.path, 'sage');
  assert.equal(v.$('img.working-in-thumb')!.getAttribute('src'), 'data:image/jpeg;base64,U1RSSVA=');
  assert.ok(v.$('.working-in-badge.stopped'));
  assert.match(v.$('.working-in-main')!.title, /^Stopped in Notes/);
  await trustedClick(v.$('.working-in-front')!);
  assert.deepEqual(fronted, [['Notes', 'com.apple.Notes']]);
  await settle(() => showTurn('failed', [sage('desktop_app_click', { app: 'Notes' })]));
  assert.ok(v.$('.working-in-badge.failed'));
});

test('no picture: the step’s screenshot, else a window glyph with the app icon beside its name; failures leave what was shown', async () => {
  const shot = { type: 'image', data: 'U0hPVA==', mimeType: 'image/jpeg' };
  thumbAnswer = { thumbnail: null, bundleId: null };
  showTurn('completed', [sage('desktop_app_screenshot', { app: 'Mail' }, 'completed', [shot])]);
  const v = await render(h(WorkingInStack, { threadId: T }));
  await settle();
  assert.match(v.$('img.working-in-thumb')!.getAttribute('src')!, /^data:image\/jpeg;base64,U0hPVA==/);
  await v.unmount();

  // no thumbnail (Screen Recording not granted): a window glyph in the thumbnail, the icon once, beside the name
  showTurn('completed', [sage('desktop_app_click', { app: 'Mail' })]);
  const w = await render(h(WorkingInStack, { threadId: T }));
  await settle();
  assert.ok(w.$('.working-in-icon svg'));
  assert.equal(w.$('.working-in-icon img'), null);
  assert.equal(w.$('.working-in-app img.working-in-app-icon')!.getAttribute('src'), 'data:image/png;base64,SUNPTg==');
  await trustedClick(w.$('.working-in-front')!);
  assert.deepEqual(fronted, [['Mail', null]]);
  await w.unmount();

  // no icon either, and both requests failing: a generic window glyph
  thumbAnswer = new Error('down');
  iconAnswer = new Error('down');
  resetAppNames();
  const x = await render(h(WorkingInStack, { threadId: T }));
  await settle();
  assert.ok(x.$('.working-in-icon svg'));
  assert.equal(x.$('.working-in-icon img'), null);
  // no icon: the name keeps its slot with the glyph, so both lines' text still starts together
  assert.ok(x.$('.working-in-app svg.working-in-app-icon'));
  await x.unmount();

  // an older preload without these calls: still the card, nothing asked
  native.computer = {};
  resetAppNames();
  const y = await render(h(WorkingInStack, { threadId: T }));
  await settle();
  assert.ok(y.$('.working-in-icon svg'));
  await trustedClick(y.$('.working-in-front')!);
  // answers that land after the card is gone are dropped
  let late: (v: any) => void = () => {};
  native.computer = {
    workingThumb: () => new Promise((r) => (late = r)),
    appIdentity: () => new Promise(() => {}),
  };
  const z = await render(h(WorkingInStack, { threadId: T }));
  await z.unmount();
  await settle(() => late({ thumbnail: 'data:x', bundleId: 'b' }));
});

test('thumbnail polling waits for its in-flight request before asking for the next frame', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const answers: ((value: any) => void)[] = [];
    native.computer.workingThumb = () => new Promise((resolve) => answers.push(resolve));
    showTurn('inProgress', [cua('let te = await cua.getApp("TextEdit")')]);
    const v = await render(h(WorkingInStack, { threadId: T }));
    await settle(() => mock.timers.tick(THUMB_POLL_MS));
    assert.equal(answers.length, 1);
    await settle(() => answers[0]({ thumbnail: 'data:first', bundleId: 'first.bundle' }));
    await settle(() => mock.timers.tick(THUMB_POLL_MS));
    assert.equal(answers.length, 2);
    await settle(() => answers[1]({ thumbnail: 'data:new', bundleId: 'new.bundle' }));
    assert.equal(v.$('img.working-in-thumb')!.getAttribute('src'), 'data:new');
    await trustedClick(v.$('.working-in-front')!);
    assert.deepEqual(fronted, [['TextEdit', 'new.bundle']]);
    await v.unmount();
  } finally {
    mock.timers.reset();
  }
});

for (const context of ['chat', 'turn']) {
  test(`working-card image and target reset when the ${context} changes with the same app`, async () => {
    const items = [cua('let te = await cua.getApp("TextEdit")')];
    showTurn('inProgress', items);
    const v = await render(h(WorkingInStack, { threadId: T }));
    await settle();
    assert.ok(v.$('img.working-in-thumb'));
    let answer!: (value: any) => void;
    native.computer.workingThumb = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    if (context === 'chat') {
      await settle(() => setStore({ runtime: { other: { loaded: true, turns: [{ id: 'turn1', status: 'inProgress', items }] } } }));
      await v.rerender(h(WorkingInStack, { threadId: 'other' }));
    } else await settle(() => showTurn('inProgress', items, 'turn2'));
    assert.equal(v.$('img.working-in-thumb') === null, true);
    await trustedClick(v.$('.working-in-front')!);
    assert.deepEqual(fronted, [['TextEdit', null]]);
    await settle(() => answer({ thumbnail: 'data:current', bundleId: 'current.bundle' }));
    assert.equal(v.$('img.working-in-thumb')!.getAttribute('src'), 'data:current');
    await v.unmount();
  });
}

// #2045: a click on the card opens the app's window larger inside MoPilot (Claude's Watch); the arrow brings it forward
const sized = (answers: Record<string, any>) => {
  native.computer.workingThumb = async (chatId: string, app: string, turnId?: string, size?: string) => {
    thumbs.push([chatId, app, turnId, size]);
    const a = answers[size ?? 'card'];
    if (a instanceof Error) throw a;
    return a;
  };
};
const large = () => thumbs.filter((t) => t[3] === 'large').length;

test('a click opens the live view with a larger capture polled once a second, Live while it works; a second click closes it', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    sized({ card: { thumbnail: 'data:small', bundleId: 'b' }, large: { thumbnail: 'data:big', bundleId: 'b' } });
    showTurn('inProgress', [cua('let te = await cua.getApp("TextEdit")')]);
    const v = await render(h(WorkingInStack, { threadId: T }));
    await settle();
    const main = v.$('.working-in-main')!;
    assert.equal(main.getAttribute('aria-expanded'), 'false');
    assert.equal(v.$('.working-in-live'), null);
    assert.equal(large(), 0, 'no large capture until the view opens');
    // an untrusted click does nothing
    main.click();
    await settle();
    assert.equal(main.getAttribute('aria-expanded'), 'false');
    await trustedClick(main);
    await settle();
    assert.equal(main.getAttribute('aria-expanded'), 'true');
    assert.match(main.title, /Hide live view$/);
    assert.equal(v.$('.working-in-stack')!.dataset.open, 'true');
    assert.equal(v.$('.working-in-card')!.dataset.open, 'true');
    assert.equal(v.$('.working-in-live img')!.getAttribute('src'), 'data:big');
    assert.equal(v.$('.working-in-live-badge')!.textContent, 'Live');
    assert.equal(large(), 1);
    const cardCalls = thumbs.filter((t) => t[3] === 'card').length;
    await settle(() => mock.timers.tick(THUMB_POLL_MS));
    assert.equal(large(), 2, 'once a second while open and working');
    assert.equal(
      thumbs.filter((t) => t[3] === 'card').length,
      cardCalls,
      'the open view’s picture fills the header too: one capture a second',
    );
    assert.equal(v.$('img.working-in-thumb')!.getAttribute('src'), 'data:big');
    // the arrow does not toggle the view
    await trustedClick(v.$('.working-in-front')!);
    assert.equal(main.getAttribute('aria-expanded'), 'true');
    // the turn ends: no Live badge, one last frame, no more polling
    await settle(() => showTurn('completed', [cua('let te = await cua.getApp("TextEdit")')]));
    assert.equal(v.$('.working-in-live-badge'), null);
    assert.ok(v.$('.working-in-live img'));
    const after = large();
    await settle(() => mock.timers.tick(THUMB_POLL_MS * 3));
    assert.equal(large(), after);
    // a second click closes it and the stack goes back to its narrow width
    await trustedClick(v.$('.working-in-main')!);
    await settle();
    assert.equal(v.$('.working-in-main')!.getAttribute('aria-expanded'), 'false');
    assert.match(v.$('.working-in-main')!.title, /Show live view$/);
    assert.equal(v.$('.working-in-live'), null);
    assert.equal(v.$('.working-in-stack')!.dataset.open, undefined);
    await v.unmount();
  } finally {
    mock.timers.reset();
  }
});

test('the open view shows the card’s picture until the larger one comes, keeps it when that fails, else says No live view', async () => {
  sized({ card: { thumbnail: 'data:small', bundleId: null }, large: new Error('down') });
  showTurn('completed', [sage('desktop_app_click', { app: 'Mail' })]);
  const v = await render(h(WorkingInStack, { threadId: T }));
  await settle();
  await trustedClick(v.$('.working-in-main')!);
  await settle();
  assert.equal(v.$('.working-in-live img')!.getAttribute('src'), 'data:small');
  await v.unmount();
  // no picture at all (Screen Recording not granted): one short line
  sized({ card: { thumbnail: null, bundleId: null }, large: { thumbnail: null, bundleId: null } });
  const w = await render(h(WorkingInStack, { threadId: T }));
  await settle();
  await trustedClick(w.$('.working-in-main')!);
  await settle();
  assert.equal(w.$('.working-in-live img'), null);
  assert.equal(w.$('.working-in-live-empty')!.textContent, 'No live view');
  // the larger capture's bundle id is the one the arrow uses when it is the only one known
  sized({ card: { thumbnail: null, bundleId: null }, large: { thumbnail: 'data:big', bundleId: 'com.apple.mail' } });
  await w.unmount();
  const x = await render(h(WorkingInStack, { threadId: T }));
  await settle();
  await trustedClick(x.$('.working-in-main')!);
  await settle();
  await trustedClick(x.$('.working-in-front')!);
  assert.deepEqual(fronted, [['Mail', 'com.apple.mail']]);
  await x.unmount();
});

test('one view open at a time; it closes when its app leaves the stack and never follows into another chat', async () => {
  sized({ card: { thumbnail: 'data:small', bundleId: null }, large: { thumbnail: 'data:big', bundleId: null } });
  const two = [sage('desktop_app_click', { app: 'Notes' }), sage('desktop_app_click', { app: 'Mail' })];
  showTurn('completed', two);
  const v = await render(h(WorkingInStack, { threadId: T }));
  await settle();
  const mains = () => v.$$('.working-in-main');
  const expanded = () => mains().map((m) => m.getAttribute('aria-expanded'));
  assert.equal(mains().length, 2);
  await trustedClick(mains()[0]);
  await settle();
  assert.deepEqual(expanded(), ['true', 'false']);
  await trustedClick(mains()[1]);
  await settle();
  assert.deepEqual(expanded(), ['false', 'true']);
  assert.equal(v.$$('.working-in-live').length, 1);
  // another chat with the same apps opens closed
  const turns = [{ id: 'turn1', status: 'completed', items: two }];
  await settle(() => setStore({ runtime: { [T]: { loaded: true, turns }, other: { loaded: true, turns } } }));
  await v.rerender(h(WorkingInStack, { threadId: 'other' }));
  await settle();
  assert.deepEqual(expanded(), ['false', 'false']);
  // back in the first chat the view stays closed: leaving the chat retired it
  await v.rerender(h(WorkingInStack, { threadId: T }));
  await settle();
  assert.deepEqual(expanded(), ['false', 'false']);
  await trustedClick(mains()[1]);
  await settle();
  assert.deepEqual(expanded(), ['false', 'true']);
  const openName = v.$('.working-in-card[data-open] .working-in-app')!.textContent;
  const other = openName === 'Notes' ? 'Mail' : 'Notes';
  // the opened app stays open in a next turn that still works in it
  await settle(() => showTurn('completed', [sage('desktop_app_click', { app: openName })], 'turn2'));
  assert.deepEqual(expanded(), ['true']);
  await settle(() => showTurn('completed', [sage('desktop_app_click', { app: other })], 'turn3'));
  assert.deepEqual(expanded(), ['false']);
  // the app coming back later does not reopen it on its own
  await settle(() => showTurn('completed', [sage('desktop_app_click', { app: openName })], 'turn4'));
  assert.deepEqual(expanded(), ['false']);
  assert.equal(v.$('.working-in-live'), null);
  await v.unmount();
});

test('a larger picture that lands after the view closed is dropped, and the polling stops', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const pendingLarge: ((v: any) => void)[] = [];
    native.computer.workingThumb = (_c: string, _a: string, _t?: string, size?: string) =>
      size === 'large'
        ? new Promise((resolve) => pendingLarge.push(resolve))
        : Promise.resolve({ thumbnail: 'data:small', bundleId: null });
    showTurn('inProgress', [cua('let te = await cua.getApp("TextEdit")')]);
    const v = await render(h(WorkingInStack, { threadId: T }));
    await settle();
    await trustedClick(v.$('.working-in-main')!);
    await settle();
    assert.equal(pendingLarge.length, 1);
    await trustedClick(v.$('.working-in-main')!);
    await settle(() => pendingLarge[0]({ thumbnail: 'data:late', bundleId: null }));
    await settle(() => mock.timers.tick(THUMB_POLL_MS * 2));
    assert.equal(pendingLarge.length, 1, 'no large capture after closing');
    // opened again: the late picture was not kept, the card's picture shows until a new one comes
    await trustedClick(v.$('.working-in-main')!);
    await settle();
    assert.equal(v.$('.working-in-live img')!.getAttribute('src'), 'data:small');
    await v.unmount();
  } finally {
    mock.timers.reset();
  }
});

test('docking the window hides the stack and closes the view, so nothing captures it; undocked it comes back closed', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    sized({ card: { thumbnail: 'data:small', bundleId: null }, large: { thumbnail: 'data:big', bundleId: null } });
    showTurn('inProgress', [cua('let te = await cua.getApp("TextEdit")')]);
    const v = await render(h(WorkingInStack, { threadId: T }));
    await settle();
    await trustedClick(v.$('.working-in-main')!);
    await settle();
    assert.equal(large(), 1);
    await settle(() => setDocked(true));
    assert.equal(v.$('.working-in-stack'), null);
    const before = thumbs.length;
    await settle(() => mock.timers.tick(THUMB_POLL_MS * 3));
    assert.equal(thumbs.length, before, 'no capture while docked');
    await settle(() => setDocked(false));
    assert.equal(v.$('.working-in-main')!.getAttribute('aria-expanded'), 'false');
    assert.equal(large(), 1);
    await v.unmount();
  } finally {
    setDocked(false);
    mock.timers.reset();
  }
});

test('reopening the view never starts on the frame it showed last time; the step is announced politely', async () => {
  sized({ card: { thumbnail: 'data:small', bundleId: null }, large: { thumbnail: 'data:old', bundleId: null } });
  showTurn('completed', [sage('desktop_app_click', { app: 'Mail' })]);
  const v = await render(h(WorkingInStack, { threadId: T }));
  await settle();
  assert.equal(v.$('.working-in-step')!.getAttribute('aria-live'), 'polite');
  assert.equal(v.$('.working-in-stack')!.getAttribute('role'), null, 'no live region around the controls');
  await trustedClick(v.$('.working-in-main')!);
  await settle();
  assert.equal(v.$('.working-in-live img')!.getAttribute('src'), 'data:old');
  await trustedClick(v.$('.working-in-main')!);
  await settle();
  // closed: the header shows the card's own picture again
  assert.equal(v.$('img.working-in-thumb')!.getAttribute('src'), 'data:small');
  // the app went away meanwhile: the larger read now brings nothing back
  sized({ card: { thumbnail: 'data:small', bundleId: null }, large: { thumbnail: null, bundleId: null } });
  await trustedClick(v.$('.working-in-main')!);
  await settle();
  assert.equal(v.$('.working-in-live img')!.getAttribute('src'), 'data:small');
  await v.unmount();
});
