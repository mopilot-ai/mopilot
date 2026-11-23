// The hand-off strip above the composer (BU-12, #1834): what it says for each hand-off, what "Open tab" and "Done, continue" do, and
// the narration of browser_request_signin it reads (src/components/thread/HandoffStrip.tsx).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fixture,
  act,
  createElement,
  render,
  call,
  chrome,
  js,
  view,
  turnOf,
  controlHandoff,
  controlStep,
  HandoffStrip,
  handoffPlace,
  resumePrompt,
} from './support/handoff-strip-kit.ts';

test("HandoffStrip: an in-app hand-off says so, opens the agent's tab in the pane, and Done, continue sends a continue message", async () => {
  fixture.state = {
    ...turnOf(call('browser_tabs_mark', { tabId: 't2', status: 'handoff' }, 'Marked t2 as handoff: sign in')),
    agentTabs: { 'native-1': [view('t1', null), view('t2', 'k2')] },
  };
  fixture.chatOf = { 'native-1': 'chat' };
  const el = await render(createElement(HandoffStrip, { threadId: 'chat' }));
  assert.equal(el.querySelector('.handoff-strip .elsewhere-title')!.textContent, 'Your turn in the browser · Sign in to continue');
  assert.equal(el.querySelector('.handoff-strip')!.getAttribute('data-reason'), 'signIn');
  const button = (label: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label)!;
  await act(async () => button('Open tab').click());
  assert.deepEqual(fixture.calls, [['openAgentBrowserTab', 'native-1', { tabKey: 'k2' }]]);
  await act(async () => button('Done, continue').click());
  assert.deepEqual(fixture.calls[1], [
    'sendMessage',
    'chat',
    "I'm done in the browser. Continue the task from where you handed it to me, and check the page again first.",
    [],
    { human: true },
  ]);
  assert.equal(el.querySelector('.handoff-strip'), null);
});

test('HandoffStrip: with the handed-over tab already in front of the open pane there is no "Open tab" (it would do nothing); Done, continue stays', async () => {
  const pane = {
    paneTabs: [{ id: 'browser-1', kind: 'browser', agentChat: 'chat' }],
    paneActive: 'browser-1',
    diffPanel: { open: true },
    route: { name: 'thread', id: 'chat' },
    split: { panes: [], focus: 'primary', primaryWeight: 1 },
  };
  fixture.state = {
    ...turnOf(js('const b = await agent.browsers.get("iab"); await tab.markHandoff(); // 2fa')),
    agentTabs: { chat: [view('t1', null, { mark: 'handoff' })] },
    ...pane,
  };
  fixture.tabInFront = true;
  const el = await render(createElement(HandoffStrip, { threadId: 'chat' }));
  const labels = () => [...el.querySelectorAll('button')].map((b) => b.textContent || b.getAttribute('aria-label'));
  assert.deepEqual(labels(), ['Done, continue', 'Dismiss']);
  // asked about the pane the window shows and the tab the hand-off names
  assert.deepEqual(fixture.paneAsked, [pane, 'chat', { tabKey: null }]);
  // the user switches the pane to another tab: Open tab is back
  fixture.tabInFront = false;
  await act(async () => fixture.update({ paneActive: 'changes' }));
  assert.deepEqual(labels(), ['Open tab', 'Done, continue', 'Dismiss']);
});

test('HandoffStrip: the Codex Browser plugin handing over in the in-app browser says so and opens the tab it marked', async () => {
  fixture.state = {
    ...turnOf(js('const b = await agent.browsers.get("iab"); await tab.markHandoff(); // sign in')),
    agentTabs: { chat: [view('t1', 'k1'), view('t2', 'k2', { mark: 'handoff' })] },
  };
  const el = await render(createElement(HandoffStrip, { threadId: 'chat' }));
  assert.equal(el.querySelector('.handoff-strip .elsewhere-title')!.textContent, 'Your turn in the browser · Sign in to continue');
  await act(async () => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Open tab')!.click());
  assert.deepEqual(fixture.calls, [['openAgentBrowserTab', 'chat', { tabKey: 'k2' }]]);
});

test('HandoffStrip: a hand-off on a tab an earlier turn opened in the in-app browser (cua_repl keeps it) shows the in-app browser', async () => {
  const open = js('let tab = await cua.createBrowserTab("iab", "http://localhost:8790/s/2fa", { visible: true });', 'ok');
  fixture.state = {
    runtime: { chat: { turns: [{}, { items: [open] }, { items: [js('await tab.markHandoff();', 'Output:')] }] } },
    agentTabs: {},
  };
  const el = await render(createElement(HandoffStrip, { threadId: 'chat' }));
  assert.equal(el.querySelector('.elsewhere-title')!.textContent, 'Your turn in the browser · Finish the step on the page');
});

test("HandoffStrip: an in-app tab main has not reported yet opens the chat's own tab", async () => {
  fixture.state = { ...turnOf(call('browser_navigate', {}, 'Navigated t9 to https://accounts.google.com/x.')), agentTabs: {} };
  const el = await render(createElement(HandoffStrip, { threadId: 'chat' }));
  await act(async () => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Open tab')!.click());
  assert.deepEqual(fixture.calls, [['openAgentBrowserTab', 'chat', { tabKey: undefined }]]);
});

test('HandoffStrip: a Chrome hand-off opens its page by address when it has one; Dismiss hides it until the next hand-off', async () => {
  const captcha = chrome('computer', { action: 'left_click' }, 'Blocked by a CAPTCHA challenge on https://t.test/');
  fixture.state = { ...turnOf(captcha), agentTabs: {} };
  let el = await render(createElement(HandoffStrip, { threadId: 'chat' }));
  assert.equal(el.querySelector('.elsewhere-title')!.textContent, 'Your turn in Chrome · Solve the CAPTCHA');
  await act(async () => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Open tab')!.click());
  assert.deepEqual(fixture.calls, [['openExternal', 'https://t.test/']]);
  await act(async () => el.querySelector<HTMLElement>('[aria-label="Dismiss"]')!.click());
  assert.equal(el.querySelector('.handoff-strip'), null);
  // a new hand-off shows again
  await act(async () => fixture.update(turnOf(captcha, js('await tab.markHandoff()', '{"status":"declined","reason":"user_took_over"}'))));
  assert.equal(el.querySelector('.elsewhere-title')!.textContent, 'Your turn in Chrome · You took over');
  // no address: no Open tab
  assert.equal(
    [...el.querySelectorAll('button')].some((b) => b.textContent === 'Open tab'),
    false,
  );
  // the agent went on: no strip
  await act(async () => fixture.update(turnOf(captcha, chrome('computer', { action: 'screenshot' }))));
  assert.equal(el.querySelector('.handoff-strip'), null);
  // a chat with no turns
  fixture.state = { runtime: {}, agentTabs: {} };
  el = await render(createElement(HandoffStrip, { threadId: 'chat' }));
  assert.equal(el.innerHTML, '');
});

test('in-app browser: browser_request_signin is a secure sign-in hand-off, with the reason the agent gave', () => {
  const pending = {
    ...call('mcp__sage__browser_request_signin', { tabId: 't2', reason: '  Sign in to\nGitHub  ' }),
    status: 'inProgress',
    result: null,
  };
  assert.deepEqual(controlHandoff(pending), {
    where: 'app',
    reason: 'signIn',
    url: null,
    tabId: 't2',
    signin: true,
    note: 'Sign in to GitHub',
  });
  assert.deepEqual(controlHandoff(call('browser_request_signin', { reason: 7 })), {
    where: 'app',
    reason: 'signIn',
    url: null,
    tabId: null,
    signin: true,
    note: '',
  });
  assert.deepEqual(controlStep(pending), { surface: 'browser', done: 'Handed the tab to you', doing: 'Handing the tab to you' });
  // a CAPTCHA hand-off says so (the reason the agent gave), not "sign in"
  assert.equal(controlHandoff(call('browser_request_signin', { reason: 'Complete the CAPTCHA' }))?.reason, 'captcha');
  // the secure login sheet: only the request is narrated, never a value
  assert.deepEqual(controlStep(call('browser_request_credentials', {}, 'status: filled')), {
    surface: 'browser',
    done: 'Asked for sign-in details',
    doing: 'Asking for sign-in details',
  });
  // once the user signed in the call returned and the agent went on: no hand-off left
  assert.equal(
    controlHandoff(
      call('browser_request_signin', { tabId: 't2' }, 'The user finished signing in on t2. Tab t2 is at https://github.com/ (GitHub).'),
    ),
    null,
  );
  // the call returns at once now (#1834): the user's turn follows it
  assert.equal(
    controlHandoff(call('browser_request_signin', { tabId: 't2' }, 'Handed t2 to the user ("Your turn on github.com").'))?.signin,
    true,
  );
});

test('HandoffStrip: a hand-off on a page that asks for a credential says "Sign in to <site>"; "Done, continue" has main continue the chat', async () => {
  const pending = {
    ...call('browser_request_signin', { tabId: 't2', reason: 'To open the private repository' }),
    status: 'inProgress',
    result: null,
  };
  fixture.state = {
    ...turnOf(pending),
    agentTabs: {
      'native-1': [
        view('t1', null),
        view('t2', 'k2', { origin: 'https://github.com', signin: { reason: 'To open the private repository', credential: true } }),
      ],
    },
  };
  fixture.chatOf = { 'native-1': 'chat' };
  const el = await render(createElement(HandoffStrip, { threadId: 'chat' }));
  assert.equal(el.querySelector('.elsewhere-title')!.textContent, 'Your turn in the browser · Sign in to github.com');
  assert.equal(el.querySelector('.elsewhere-body')!.textContent, 'To open the private repository');
  const button = (label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === label)!;
  await act(async () => button('Open tab').click());
  await act(async () => button('Done, continue').click());
  assert.deepEqual(fixture.calls, [
    ['openAgentBrowserTab', 'native-1', { tabKey: 'k2' }],
    ['signinDone', 'native-1', 't2'],
  ]);
  assert.equal(el.querySelector('.handoff-strip'), null);
});

test('HandoffStrip: with nothing waiting any more, "Done, continue" tells the agent in a message; the waiting tab is found without an id', async () => {
  fixture.state = {
    ...turnOf(call('browser_request_signin', {})),
    agentTabs: { chat: [view('t1', null), view('t3', 't3', { signin: { reason: '' } })] },
  };
  fixture.signinOk = false;
  let el = await render(createElement(HandoffStrip, { threadId: 'chat' }));
  assert.equal(el.querySelector('.elsewhere-title')!.textContent, 'Your turn in the browser · Sign in to continue');
  assert.equal(el.querySelector('.elsewhere-body'), null);
  await act(async () => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Done, continue')!.click());
  assert.deepEqual(fixture.calls[0], ['signinDone', 'chat', 't3']);
  assert.deepEqual(fixture.calls[1], [
    'sendMessage',
    'chat',
    "I'm done in the browser. Continue the task from where you handed it to me, and check the page again first.",
    [],
    { human: true },
  ]);
  // main hasn't reported the chat's tabs: the chat's waiting tab, by no id
  fixture.calls = [];
  fixture.signinOk = true;
  fixture.state = { ...turnOf(call('browser_request_signin', { reason: 'x' })), agentTabs: {} };
  el = await render(createElement(HandoffStrip, { threadId: 'chat' }));
  await act(async () => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Done, continue')!.click());
  assert.deepEqual(fixture.calls, [['signinDone', 'chat', null]]);
});

test('HandoffStrip (#1834): a hand-off on a page that asks for no credential is the step on the site, or the CAPTCHA', async () => {
  const strip = async (reason: string) => {
    fixture.state = {
      ...turnOf(call('browser_request_signin', { tabId: 't2', reason })),
      agentTabs: { chat: [view('t2', 't2', { origin: 'https://coa.immigration.gov.tw', signin: { reason, credential: false } })] },
    };
    const el = await render(createElement(HandoffStrip, { threadId: 'chat' }));
    return el.querySelector('.elsewhere-title')!.textContent;
  };
  assert.equal(await strip('Enter your passport number'), 'Your turn in the browser · Finish the step on coa.immigration.gov.tw');
  assert.equal(await strip('Complete the CAPTCHA'), 'Your turn in the browser · Solve the CAPTCHA');
});

test('HandoffStrip: a hand-off the user took to their Chrome is their turn in Chrome; Done tells the agent in a message', async () => {
  fixture.calls = [];
  fixture.state = {
    ...turnOf(call('browser_request_signin', { tabId: 't2' }, 'Handed t2 to the user ("Sign in to accounts.google.com").')),
    agentTabs: { chat: [view('t2', 't2', { origin: 'https://accounts.google.com', signin: null, moved: true })] },
  };
  const el = await render(createElement(HandoffStrip, { threadId: 'chat' }));
  assert.equal(el.querySelector('.elsewhere-title')!.textContent, 'Your turn in Chrome · Sign in to continue');
  assert.equal(
    [...el.querySelectorAll('button')].some((b) => b.textContent === 'Open tab'),
    false,
  );
  await act(async () => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Done, continue')!.click());
  assert.deepEqual(fixture.calls.at(-1), [
    'sendMessage',
    'chat',
    "I'm done in Chrome. Continue the task from where you handed it to me, and check the page again first.",
    [],
    { human: true },
  ]);
});

test("HandoffStrip: a Done, continue main didn't take brings the strip back, to try again", async () => {
  fixture.calls = [];
  fixture.state = {
    ...turnOf(call('browser_tabs_mark', { tabId: 't2', status: 'handoff' }, 'Marked t2 as handoff: sign in')),
    agentTabs: {},
  };
  const button = (el: Element, label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === label)!;
  try {
    // main refused it (sendMessage said why), or the send failed
    fixture.sent = false;
    let el = await render(createElement(HandoffStrip, { threadId: 'chat' }));
    await act(async () => button(el, 'Done, continue').click());
    assert.ok(el.querySelector('.handoff-strip'));
    fixture.sendFails = new Error('bridge gone');
    await act(async () => button(el, 'Done, continue').click());
    assert.ok(el.querySelector('.handoff-strip'));
    assert.deepEqual(fixture.calls.at(-1), ['failed', "Couldn't send", 'bridge gone']);
    // a newer hand-off the user dismissed while the send was on its way stays dismissed
    fixture.sendFails = null;
    let refuse!: (v: boolean) => void;
    fixture.sent = new Promise((r) => (refuse = r));
    await act(async () => button(el, 'Done, continue').click());
    await act(async () =>
      fixture.update(turnOf(call('browser_tabs_mark', { tabId: 't4', status: 'handoff' }, 'Marked t4 as handoff: pay'))),
    );
    await act(async () => (el.querySelector('[aria-label="Dismiss"]') as HTMLElement).click());
    await act(async () => refuse(false));
    assert.equal(el.querySelector('.handoff-strip'), null);
    // telling main the sign-in is done failed
    fixture.sendFails = null;
    fixture.signinFails = new Error('main is gone');
    fixture.state = { ...turnOf(call('browser_request_signin', {})), agentTabs: { chat: [view('t3', 't3', { signin: { reason: '' } })] } };
    el = await render(createElement(HandoffStrip, { threadId: 'chat' }));
    await act(async () => button(el, 'Done, continue').click());
    assert.ok(el.querySelector('.handoff-strip'));
    assert.deepEqual(fixture.calls.at(-1), ['failed', "Couldn't tell the agent you're done", 'main is gone']);
  } finally {
    fixture.sent = undefined;
    fixture.sendFails = null;
    fixture.signinFails = null;
  }
});

test('handoffPlace and resumePrompt name the browser the user picks up in', () => {
  const h = { where: 'chrome', reason: 'payment', url: null, tabId: null };
  assert.equal(handoffPlace(h as any), 'Chrome');
  assert.equal(
    resumePrompt(h as any),
    "I'm done in Chrome. Continue the task from where you handed it to me, and check the page again first.",
  );
});

/* ---------- user bubbles ---------- */
