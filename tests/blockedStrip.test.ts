// The ways-forward strip above the composer (src/components/thread/BlockedStrip.tsx): a refused browser or
// desktop step shows what happened and its one-click choices; each choice acts (allow the site for the chat,
// open it, take over) and tells the agent to continue, steering the running turn where the harness can.
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { continueMessage } from '../shared/chromeHandoff.mjs';
import { native, mockStore, render, settle, setStore, resetStore, callsTo, moduleCalls } from './support/thread-kit.ts';
import { iconStubs, mockSource, taggedIcon } from './support/stubs.ts';

const sent: any[] = [];
mockStore({
  chatOf: (id: string) => (id === 'native-1' ? 'chat' : id),
  sendMessage: async (...a: any[]) => {
    sent.push(a);
    if (sendFails) throw sendFails;
    return sendAnswer;
  },
  toastFailure: (what: string) => (e: Error) => failures.push([what, e.message]),
});
let sendAnswer: boolean | Promise<boolean> = true;
let sendFails: Error | null = null;
const failures: unknown[] = [];
mockSource('src/components/ui/icons.tsx', iconStubs(taggedIcon));
const io: any[] = [];
let allowResult: any = 'allowed';
native.browser.allowSiteInChat = async (...a: any[]) => (io.push(['allowSiteInChat', ...a]), allowResult);
native.browser.takeOver = async (...a: any[]) => (io.push(['takeOver', ...a]), true);
native.shell.openExternal = async (...a: any[]) => void io.push(['openExternal', ...a]);
// Your Chrome: off unless a test sets it up
let chromeState: any = { active: 'builtin', hasToken: false, extensionUrl: '' };
let channelChanged: ((s: any) => void) | null = null;
let handoffResult: any = { ok: true };
native.browser.chromeState = async () => chromeState;
native.browser.handoffContinuation = async ({ url }: any) => ({
  message: continueMessage(handoffResult.route, url),
  precondition: { url, token: 'current' },
});
native.browser.onChannelChanged = (cb: (s: any) => void) => ((channelChanged = cb), () => void (channelChanged = null));
native.browser.continueInChrome = async (...a: any[]) => {
  io.push(['continueInChrome', ...a]);
  if (handoffResult instanceof Error) throw handoffResult;
  if (typeof handoffResult === 'string') throw handoffResult;
  return handoffResult;
};

const { createElement } = await import('react');
const { BlockedStrip } = await import('../src/components/thread/BlockedStrip.tsx');

afterEach(() => {
  sent.length = 0;
  io.length = 0;
  moduleCalls.length = 0;
  allowResult = 'allowed';
  chromeState = { active: 'builtin', hasToken: false, extensionUrl: '' };
  handoffResult = { ok: true };
  resetStore();
});

let seq = 0;
const refusal = (tool: string, args: any, message: string, reason: string) => ({
  id: `i${++seq}`,
  type: 'mcpToolCall',
  tool,
  arguments: args,
  status: 'failed',
  error: { message: `${message}\n<refusal reason="${reason}" retryable="false">\nnext: x\n</refusal>` },
});
const turn = (...items: any[]) => setStore({ runtime: { chat: { turns: [{ id: 't', items }] } } });
const strip = async () => {
  const v = await render(createElement(BlockedStrip, { threadId: 'chat' }));
  const button = (label: string) => v.$$('button').find((b) => b.textContent === label || b.getAttribute('aria-label') === label)!;
  return { ...v, button, click: (label: string) => settle(() => button(label).click()) };
};
const steer = (text: string) => ['chat', text, [], { human: true, steer: true }];

test('nothing refused, or no turn: no strip', async () => {
  const v = await render(createElement(BlockedStrip, { threadId: 'chat' }));
  assert.equal(v.$('.blocked-strip'), null);
  turn({ id: 'm', type: 'agentMessage' });
  assert.equal(v.$('.blocked-strip'), null);
});

test('a refused site: Allow this site allows it for the chat and steers the turn on', async () => {
  turn(
    refusal('mcp__sage__browser_navigate', { url: 'https://a.test/x' }, 'The user did not allow https://a.test.', 'site_permission_denied'),
  );
  const v = await strip();
  assert.equal(v.$('.blocked-strip')!.getAttribute('data-reason'), 'site_permission_denied');
  assert.equal(v.$('.elsewhere-title')!.textContent, 'You didn’t allow a.test.');
  assert.deepEqual(
    v.$$('.elsewhere-actions button').map((b) => b.textContent || b.getAttribute('aria-label')),
    ['Allow this site', 'Open in your browser', 'I’ll take over', 'Dismiss'],
  );
  await v.click('Allow this site');
  assert.deepEqual(io, [['allowSiteInChat', 'chat', 'https://a.test', 'read', 'iab']]);
  assert.deepEqual(sent, [steer('I allowed a.test for this chat. Continue the task.')]);
  assert.equal(v.$('.blocked-strip'), null, 'answered: the strip goes');
});

test("a follow-up main didn't take, or that failed, brings the strip back to choose again", async () => {
  turn(
    refusal('mcp__sage__browser_navigate', { url: 'https://a.test/x' }, 'The user did not allow https://a.test.', 'site_permission_denied'),
  );
  const v = await strip();
  try {
    sendAnswer = false;
    await v.click('Allow this site');
    assert.equal(sent.length, 1);
    assert.ok(v.$('.blocked-strip'), 'refused: the strip is back');
    sendFails = new Error('bridge gone');
    await v.click('Allow this site');
    assert.ok(v.$('.blocked-strip'), 'failed: the strip is back');
    assert.deepEqual(failures, [["Couldn't send", 'bridge gone']]);
    // a newer refusal the user dismissed while the send was on its way stays dismissed
    sendFails = null;
    let refuse!: (v: boolean) => void;
    sendAnswer = new Promise((r) => (refuse = r));
    await v.click('Allow this site');
    turn(refusal('browser_navigate', { url: 'https://e.test/' }, 'The user did not allow https://e.test.', 'site_permission_denied'));
    await settle(() => {});
    await v.click('Dismiss');
    await settle(() => refuse(false));
    assert.equal(v.$('.blocked-strip'), null);
  } finally {
    sendAnswer = true;
    sendFails = null;
    failures.length = 0;
  }
});

test('read only: Allow changes here asks for write; a high-risk site only asks again; a blocked one says so', async () => {
  turn(refusal('browser_click', { url: 'https://b.test/' }, 'Read only.', 'site_read_only'));
  let v = await strip();
  await v.click('Allow changes here');
  assert.deepEqual(io, [['allowSiteInChat', 'chat', 'https://b.test', 'write', 'iab']]);
  assert.match(sent[0][1], /read and change pages/);
  await v.unmount();
  sent.length = 0;
  allowResult = 'ask';
  turn(
    refusal(
      'browser_navigate',
      { url: 'https://www.chase.com/' },
      'The user did not allow https://www.chase.com.',
      'site_permission_denied',
    ),
  );
  v = await strip();
  await v.click('Allow this site');
  assert.deepEqual(sent, [steer("Try www.chase.com again: I'll answer when it asks for permission.")]);
  await v.unmount();
  sent.length = 0;
  allowResult = false;
  turn(refusal('browser_navigate', { url: 'https://c.test/' }, 'The user did not allow https://c.test.', 'site_permission_denied'));
  v = await strip();
  await v.click('Allow this site');
  assert.deepEqual(sent, [], 'nothing sent');
  assert.equal(callsTo('store:toast').length, 1);
  assert.ok(v.$('.blocked-strip'), 'the strip stays');
});

test('a blocked risk class shows only the reason; Dismiss hides the strip', async () => {
  turn(refusal('browser_navigate', { url: 'http://169.254.169.254/' }, 'Cloud metadata endpoint', 'site_blocked'));
  const v = await strip();
  assert.equal(v.$('.elsewhere-title')!.textContent, 'This site is blocked for browser control. Do this step yourself if you need it.');
  assert.deepEqual(
    v.$$('.elsewhere-actions button').map((b) => b.getAttribute('aria-label')),
    ['Dismiss'],
  );
  await v.click('Dismiss');
  assert.equal(v.$('.blocked-strip'), null);
});

test("a read-only chat: Change mode opens the composer's permission menu and sends nothing", async () => {
  turn(refusal('browser_click', {}, 'This chat is in a read-only mode.', 'chat_read_only'));
  const v = await strip();
  let opened = 0;
  const open = () => void opened++;
  window.addEventListener('open-permission-picker', open);
  try {
    await v.click('Change mode');
    assert.equal(opened, 1);
    assert.deepEqual(sent, []);
    assert.ok(v.$('.blocked-strip'), 'the strip stays until the user acts');
  } finally {
    window.removeEventListener('open-permission-picker', open);
  }
});

test("I'll take over hands the agent's tab to the user; Done hands it back and tells the agent", async () => {
  setStore({ agentTabs: { 'native-1': [] } });
  turn(refusal('browser_click', {}, 'The user did not allow this action on https://d.test.', 'action_declined'));
  const v = await strip();
  await v.click('I’ll take over');
  assert.deepEqual(io, [['takeOver', 'native-1', null, true]]);
  assert.equal(v.$('.elsewhere-title')!.textContent, 'Your turn: tell the agent when you’re done');
  assert.deepEqual(sent, []);
  await v.click('Done, continue');
  assert.deepEqual(io[1], ['takeOver', 'native-1', null, false]);
  assert.deepEqual(sent, [steer('I did that step myself in the browser. Check the page again first, then continue the task.')]);
});

test('I’ll take over on a tab that closed or a turn that ended takes nothing over: the strip never says "Your turn" (#1866)', async () => {
  const took = native.browser.takeOver;
  native.browser.takeOver = async (...a: any[]) => (io.push(['takeOver', ...a]), false);
  try {
    turn(refusal('browser_click', {}, 'The user did not allow this action on https://d.test.', 'action_declined'));
    const v = await strip();
    await v.click('I’ll take over');
    assert.deepEqual(io, [['takeOver', 'chat', null, true]]);
    assert.doesNotMatch(v.$('.elsewhere-title')?.textContent ?? '', /Your turn/);
    assert.ok(v.$('.blocked-strip'), 'the strip stays, to choose again');
    assert.deepEqual(sent, []);
  } finally {
    native.browser.takeOver = took;
  }
});

test('Open in your browser opens the site; Done says the step was finished there (no agent tabs: the chat id)', async () => {
  turn(refusal('browser_type', {}, 'Sign in on https://e.test/login first.', 'signin_cancelled'));
  const v = await strip();
  await v.click('Open in your browser');
  assert.deepEqual(io, [['openExternal', 'https://e.test']]);
  await v.click('Done, continue');
  assert.match(sent[0][1], /^I finished that step on e\.test in my own browser/);
  await v.unmount();
  // take over with no agent tabs known: the chat's own key
  io.length = 0;
  turn(refusal('browser_click', {}, 'x', 'user_declined'));
  const w = await strip();
  await w.click('I’ll take over');
  assert.deepEqual(io, [['takeOver', 'chat', null, true]]);
});

test('desktop: Allow <app> asks the agent to request it again; screen control likewise; I’ll take over waits for Done', async () => {
  const denied = {
    id: 'd1',
    type: 'mcpToolCall',
    tool: 'desktop_request_access',
    arguments: { apps: ['TextEdit'] },
    status: 'completed',
    result: { content: [{ type: 'text', text: JSON.stringify({ denied: [{ app: 'TextEdit', reason: 'the user did not allow it' }] }) }] },
  };
  turn(denied);
  let v = await strip();
  await v.click('Allow TextEdit');
  assert.deepEqual(io, [], 'no grant from here: the access card asks again');
  assert.match(sent[0][1], /^You can use TextEdit now: ask for access again/);
  await v.unmount();
  sent.length = 0;
  turn({
    id: 'd2',
    type: 'mcpToolCall',
    tool: 'desktop_left_click',
    status: 'failed',
    error: { message: "The user didn't allow MoPilot to control the screen" },
  });
  v = await strip();
  await v.click('Allow screen control');
  assert.match(sent[0][1], /allow screen control this time/);
  await v.unmount();
  sent.length = 0;
  turn({
    id: 'd3',
    type: 'mcpToolCall',
    tool: 'desktop_left_click',
    status: 'failed',
    error: { message: "The user didn't allow MoPilot to control the screen" },
  });
  v = await strip();
  await v.click('I’ll take over');
  assert.deepEqual(io, []);
  await v.click('Done, continue');
  assert.match(sent[0][1], /Look at the screen again/);
});

test('Your Chrome set up: "Open in your Chrome" hands the site to the chat\'s Chrome; a failed hand-off opens the default browser', async () => {
  chromeState = { active: 'builtin', hasToken: true, extensionUrl: '' };
  turn(refusal('browser_type', {}, 'Sign in on https://e.test/login first.', 'signin_cancelled'));
  const v = await strip();
  assert.ok(v.button('Open in your Chrome'));
  await v.click('Open in your Chrome');
  assert.deepEqual(io, [['continueInChrome', { chatId: 'chat', url: 'https://e.test' }]]);
  assert.equal(v.$('.elsewhere-title')!.textContent, 'Your turn: tell the agent when you’re done');
  await v.click('Done, continue');
  assert.match(sent[0][1], /^I finished that step on e\.test in my own browser/);
  await v.unmount();
  // a hand-off the user cancelled opens nothing else; a failed one says why and opens the default browser
  for (const [result, toasts, opened] of [
    [{ ok: false, cancelled: true }, 0, false],
    [{ ok: false, message: 'Your Chrome is unavailable.' }, 1, true],
    [{ ok: false }, 1, true],
    [new Error('ipc'), 1, true],
    ['ipc went away', 1, true],
  ] as const) {
    io.length = 0;
    moduleCalls.length = 0;
    handoffResult = result;
    turn(refusal('browser_type', {}, 'Sign in on https://e.test/login first.', 'password_field'));
    const w = await strip();
    await w.click('Open in your Chrome');
    assert.equal(callsTo('store:toast').length, toasts);
    assert.equal(
      io.some((c) => c[0] === 'openExternal'),
      opened,
    );
    await w.unmount();
  }
  assert.match(String(callsTo('store:toast')[0]?.[0] ?? ''), /Opened it in your default browser instead/);
});

test('the label follows the browser channel as it changes; a strip gone before Chrome answers keeps its label', async () => {
  turn(refusal('browser_navigate', { url: 'https://a.test/x' }, 'The user did not allow https://a.test.', 'site_permission_denied'));
  const v = await strip();
  assert.ok(v.button('Open in your browser'));
  await settle(() => channelChanged?.({ active: 'chrome', hasToken: true, extensionUrl: '' }));
  assert.ok(v.button('Open in your Chrome'));
  await v.unmount();
  assert.equal(channelChanged, null, 'unsubscribed');
  // chromeState failing, or answering after unmount: the default browser, no update
  native.browser.chromeState = async () => {
    throw new Error('no main');
  };
  const warn = mock.method(console, 'warn', () => {});
  const w = await strip();
  assert.ok(w.button('Open in your browser'));
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /Chrome state/);
  warn.mock.restore();
  await w.unmount();
  let answer: (s: any) => void = () => {};
  native.browser.chromeState = () => new Promise((r) => (answer = r));
  const x = await strip();
  await x.unmount();
  answer({ hasToken: true });
  native.browser.chromeState = async () => null;
  const y = await strip();
  assert.ok(y.button('Open in your browser'));
  native.browser.chromeState = async () => chromeState;
  native.browser.handoffContinuation = async ({ url }: any) => ({
    message: continueMessage(handoffResult.route, url),
    precondition: { url, token: 'current' },
  });
});

test("Your Chrome's hand-off changed the saved Preferred browser: a toast says so and offers Browser settings; an unchanged one, or a vendor's route, says nothing (#1523)", async () => {
  chromeState = { active: 'builtin', hasToken: true, extensionUrl: '' };
  const { PREFERRED_CHANGED } = await import('../shared/chromeHandoff.mjs');
  for (const [result, channel, toasts] of [
    [{ ok: true, url: 'https://e.test/', route: 'your-chrome', preferredChanged: true }, 1, 1],
    [{ ok: true, url: 'https://e.test/', route: 'your-chrome', preferredChanged: false }, 1, 0],
    [{ ok: true, url: 'https://e.test/', route: 'claude-in-chrome' }, 0, 0],
  ] as const) {
    moduleCalls.length = 0;
    handoffResult = result;
    turn(refusal('browser_type', {}, 'Sign in on https://e.test/login first.', 'signin_cancelled'));
    const v = await strip();
    await v.click('Open in your Chrome');
    assert.deepEqual(callsTo('store:setPrefs'), channel ? [[{ browserChannel: 'chrome' }]] : [], result.route);
    const toastCalls = callsTo('store:toast');
    assert.equal(toastCalls.length, toasts, result.route);
    if (toasts) {
      const [text, kind, opts] = toastCalls[0];
      assert.equal(text, PREFERRED_CHANGED);
      assert.equal(kind, 'info');
      assert.equal(opts.action.label, 'Browser settings');
      opts.action.run();
      assert.deepEqual(callsTo('store:navigate'), [[{ name: 'settings', section: 'browser' }]]);
    }
    await v.unmount();
  }
});

test("the chat's Chrome controller picks the site up: a vendor's or MoPilot's Chrome tools without a Your Chrome token; no controller opens the default browser", async () => {
  const routes: any[] = [];
  let route: any = 'codex-browser-plugin';
  native.browser.handoffRoute = async (chatId: string) => (routes.push(chatId), route);
  try {
    handoffResult = { ok: true, url: 'https://e.test/', route: 'codex-browser-plugin' };
    turn(refusal('browser_type', {}, 'Sign in on https://e.test/login first.', 'signin_cancelled'));
    const v = await strip();
    assert.deepEqual(routes, ['chat']);
    await v.click('Open in your Chrome');
    assert.deepEqual(io, [['continueInChrome', { chatId: 'chat', url: 'https://e.test' }]]);
    await v.click('Done, continue');
    // the agent is told the tool that picks the site up in the user's Chrome
    assert.match(
      sent[0][1],
      /^<sage-browser-handoff>\nThe user opened this site in their Chrome at https:\/\/e\.test\/\. .*browser\.user\.claimTab/,
    );
    assert.match(sent[0][1], /\nContinue in Chrome · e\.test$/);
    await v.unmount();
    // MoPilot's Chrome tools: a hand-off that names no address continues at the refused site
    sent.length = 0;
    handoffResult = { ok: true, route: 'relay' };
    const r = await strip();
    await r.click('Open in your Chrome');
    await r.click('Done, continue');
    assert.match(
      sent[0][1],
      /^<sage-browser-handoff>\nThe user opened this site in their Chrome at https:\/\/e\.test\. .*tabs_context_mcp/,
    );
    // the channel changing reads the route again
    route = 'none';
    await settle(() => channelChanged?.({ active: 'builtin', hasToken: true, extensionUrl: '' }));
    assert.deepEqual(routes, ['chat', 'chat', 'chat']);
    await r.unmount();
    // no controller (Your Chrome off), even with a token: the default browser, and no error
    io.length = 0;
    sent.length = 0;
    chromeState = { active: 'builtin', hasToken: true, extensionUrl: '' };
    turn(refusal('browser_type', {}, 'Sign in on https://e.test/login first.', 'password_field'));
    const w = await strip();
    await w.click('Open in your browser');
    assert.deepEqual(io, [['openExternal', 'https://e.test']]);
    assert.equal(callsTo('store:toast').length, 0);
    await w.click('Done, continue');
    assert.match(sent[0][1], /^I finished that step on e\.test in my own browser/);
    await w.unmount();
    // the route can't be read: Your Chrome's token decides, as before
    native.browser.handoffRoute = async () => {
      throw new Error('no main');
    };
    const warn = mock.method(console, 'warn', () => {});
    const x = await strip();
    assert.ok(x.button('Open in your Chrome'));
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /route to Chrome/);
    warn.mock.restore();
    await x.unmount();
  } finally {
    native.browser.handoffRoute = async () => undefined;
  }
});

test('a site the user blocked in Codex Browser Use: Browser settings opens them and sends nothing; a policy block offers nothing (#1319 G13)', async () => {
  turn(
    refusal(
      'browser_navigate',
      { url: 'https://blocked.test/' },
      'You blocked this site in Codex Browser Use, which MoPilot applies in every chat. https://blocked.test/',
      'codex_site_blocked',
    ),
  );
  let v = await strip();
  assert.equal(v.$('.elsewhere-title')!.textContent, 'blocked.test is blocked in your Codex Browser Use settings.');
  await v.click('Browser settings');
  assert.deepEqual(callsTo('store:navigate'), [[{ name: 'settings', section: 'browser' }]]);
  assert.deepEqual(sent, []);
  assert.deepEqual(io, []);
  await v.unmount();
  turn(
    refusal(
      'browser_navigate',
      { url: 'https://x.corp.test/' },
      "Your organization's Codex Browser Use policy blocks this site. https://x.corp.test/",
      'codex_policy_blocked',
    ),
  );
  v = await strip();
  assert.equal(
    v.$('.elsewhere-title')!.textContent,
    'x.corp.test is blocked by a Codex Browser Use policy. Ask whoever manages Codex, or do this step yourself.',
  );
  assert.deepEqual(
    v.$$('.elsewhere-actions button').map((b) => b.textContent || b.getAttribute('aria-label')),
    ['Dismiss'],
  );
});
