// MoMo's home surfaces in the renderer, first half (src/components/momo/home): first run, the Runs-on pill and its popover, the home's banners, chat rows and the approval card, each drawn from the fixture view through the seam and clicked in happy-dom. navigate is recorded.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  act,
  clock,
  count,
  createElement,
  createFixtureSeam,
  createRoot,
  fixtureView,
  flush,
  mount,
  momoHomeScenario,
  advanceMove,
  failMove,
  MomoHomePage,
  nav,
  NOW,
  pillText,
  resetMomoHomeStore,
  scenarioView,
  setMomoHomeSeam,
  shortDay,
  minutesSince,
  window,
} from './support/momoHomeRig.ts';

test('the switch is read from this window and the copy helpers print the way the design does', () => {
  assert.equal(momoHomeScenario(), null);
  for (const off of ['', '0', 'false', 'off', ' OFF ']) {
    (globalThis as any).localStorage.setItem('momo.homeUi', off);
    assert.equal(momoHomeScenario(), null, `"${off}" is off`);
  }
  (globalThis as any).localStorage.setItem('momo.homeUi', '1');
  assert.equal(momoHomeScenario(), '1');
  (globalThis as any).localStorage.setItem('momo.homeUi', 'asleep');
  assert.equal(momoHomeScenario(), 'asleep');
  (globalThis as any).localStorage.clear();
  const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
  Object.defineProperty(globalThis, 'localStorage', {
    get: () => {
      throw new Error('blocked');
    },
    configurable: true,
  });
  assert.equal(momoHomeScenario(), null);
  Object.defineProperty(globalThis, 'localStorage', real);
  assert.match(clock(NOW), /^\d{1,2}:\d{2}\s?(AM|PM)$/);
  assert.match(shortDay(NOW), /^Nov 24$/);
  assert.equal(minutesSince(NOW - 180_000, NOW), '3 min');
  assert.equal(minutesSince(NOW, NOW), '1 min');
  assert.equal(count(1, 'person', 'people'), '1 person');
  assert.equal(count(2, 'person', 'people'), '2 people');
  const home = fixtureView().home;
  assert.equal(pillText(home), 'Runs on Studio');
  assert.equal(pillText({ ...home, state: 'asleep' }), 'Studio is asleep');
  assert.equal(pillText({ ...home, state: 'moving', move: null }), 'Moving to Studio');
  assert.equal(pillText({ ...home, machineName: null }), 'Runs on a machine');
});

test('first run: where it lives → what it can read → how it reaches you, then the chat', async () => {
  const m = await mount('first-run');
  assert.ok(m.text().includes('Where should MoMo live?'));
  assert.ok(m.text().includes('Recommended'));
  assert.ok(m.text().includes('MoPilot there is out of date'));
  assert.ok(m.text().includes('Not set up'));
  assert.ok(m.btn('Continue with Studio'));
  await m.click(/^This Mac/);
  assert.ok(m.btn('Continue with This Mac'));
  await m.click('Continue with This Mac');
  assert.ok(m.text().includes('Connect Gmail and Calendar'));
  assert.ok(m.text().includes('The sign-in stays on This Mac. Not on your phone.'));
  await m.click('Continue in browser');
  assert.ok(m.text().includes('Finish in your browser'));
  assert.ok(m.text().includes('Waiting for Google…'));
  await m.click('Cancel');
  await m.click('Continue in browser');
  await act(async () => void (await m.seam.act({ type: 'setup.google', to: 'connected' })));
  assert.ok(m.text().includes('Gmail and Calendar · read only'));
  await m.click('Disconnect');
  assert.ok(m.text().includes('Connect Gmail and Calendar'));
  await act(async () => void (await m.seam.act({ type: 'setup.google', to: 'failed' })));
  await flush();
  assert.ok(m.text().includes('Google didn’t connect. Try again.'));
  await m.click('Not now');
  assert.ok(m.text().includes('Let MoMo reach you'));
  assert.ok(m.text().includes('At most 6 a day. Quiet from 10:00 PM to 8:00 AM.'));
  await m.click('Not now');
  assert.ok(m.text().includes('Notifications are off. MoMo keeps things in Chat.'));
  await m.click('Open Settings');
  assert.deepEqual(nav.pop(), { name: 'settings', section: 'momo' });
  await m.click('Continue');
  assert.ok(m.btn('Chat'));
  await m.close();
  const again = await mount('first-run');
  await again.click('Continue with Studio');
  await again.click('Not now');
  await again.click('Not now');
  await again.click('Continue');
  assert.ok(again.btn('Tasks'));
  await again.close();
  const connected = await mount('first-run');
  await connected.click('Continue with Studio');
  await connected.click('Continue in browser');
  await act(async () => void (await connected.seam.act({ type: 'setup.google', to: 'connected' })));
  await connected.click('Done');
  await connected.click('Allow notifications');
  assert.ok(connected.btn('Rules'));
  await connected.close();
});

test('first run with no machine online offers no radio to pick', async () => {
  const v = scenarioView('first-run');
  v.home.machines = v.home.machines.map((x) => ({ ...x, status: 'offline' as const, recommended: false }));
  setMomoHomeSeam(createFixtureSeam(v, () => NOW));
  resetMomoHomeStore();
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(MomoHomePage, {})));
  await flush();
  const go = [...(window.document.body as any).querySelectorAll('button')].find((b: any) => b.textContent.startsWith('Continue with'));
  assert.equal(go.disabled, true);
  await act(async () => root.unmount());
  host.remove();
});

test('the pill and its popover: where MoMo runs, Move here with its steps, Cancel before the switch, Update, Set up', async () => {
  const m = await mount(null);
  assert.ok(m.btn('Runs on Studio'));
  await m.click('Runs on Studio');
  assert.ok(m.text().includes('Where MoMo runs'));
  assert.ok(m.text().includes('MoMo is here'));
  assert.ok(m.text().includes('Moving takes about a minute. Notes, rules, tasks and sign-ins move with it.'));
  await m.click('Update, then move');
  await m.click('Set up');
  await m.click('Move here');
  assert.ok(m.text().includes('Moving MoMo to This Mac'));
  assert.ok(m.text().includes('From Studio · about a minute'));
  assert.ok(m.text().includes('You can cancel until the switch.'));
  assert.ok(m.btn('Moving to This Mac'));
  await m.click('Cancel');
  assert.ok(m.btn('Runs on Studio'));
  await act(async () => void (await m.seam.act({ type: 'move.start', machineId: 'this-mac' })));
  for (let i = 0; i < 3; i++) await act(async () => m.seam.script(advanceMove));
  await flush();
  assert.equal(m.btn('Cancel'), undefined, 'the switch cannot be cancelled');
  await act(async () => m.seam.script(advanceMove));
  await act(async () => m.seam.script(advanceMove));
  await act(async () => m.seam.script(advanceMove));
  await flush();
  assert.ok(m.btn('Runs on This Mac'));
  await m.close();
  const refused = await mount(null, 'chat', 'Studio stopped answering.');
  await refused.click('Runs on Studio');
  await refused.click('Move here');
  assert.ok(refused.text().includes('Studio stopped answering.'));
  await refused.close();
});

test('a failed move says the cause and the last step with Retry and Stay; a move that finished late says the old machine is offline', async () => {
  const m = await mount('move-failed');
  assert.ok(m.text().includes('Move didn’t finish'));
  assert.ok(m.text().includes('Mac mini stopped answering. MoMo is still on Studio. Nothing was lost.'));
  assert.ok(m.text().includes('Last step reached: Copied'));
  await m.click('Retry');
  assert.ok(m.text().includes('Moving MoMo to Mac mini'));
  await act(async () => m.seam.script((v, now) => failMove(v, 'Again.', now)));
  await flush();
  await m.click('Stay on Studio');
  assert.ok(m.btn('Runs on Studio'));
  await m.close();
  const v = scenarioView(null);
  v.home.move = {
    moveId: 'm',
    from: { machineId: 'studio', name: 'Studio' },
    to: { machineId: 'mac-mini', name: 'Mac mini' },
    step: 'cleaning-up',
    outcome: 'moved',
    finishedAt: NOW,
    failure: null,
    oldMachineOffline: true,
  };
  v.home.machineName = 'Mac mini';
  setMomoHomeSeam(createFixtureSeam(v, () => NOW));
  resetMomoHomeStore();
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(MomoHomePage, {})));
  await flush();
  const t = (window.document.body as any).textContent as string;
  assert.ok(t.includes('Moved to Mac mini'));
  assert.ok(t.includes('Studio is offline and still holds a copy. It clears itself when it is back.'));
  await act(async () => [...(window.document.body as any).querySelectorAll('button')].find((b: any) => b.textContent === 'Got it').click());
  await flush();
  assert.ok(!(window.document.body as any).textContent.includes('Moved to Mac mini'));
  await act(async () => root.unmount());
  host.remove();
});

test('asleep: the pill and banner say so, Move MoMo opens the popover, Wake brings it back; a message waits', async () => {
  const m = await mount('asleep');
  assert.ok(m.btn('Studio is asleep'));
  assert.ok(m.text().includes('MoMo’s home went to sleep at'));
  assert.ok(m.text().includes('Nothing is being checked. Your messages wait here.'));
  assert.ok((m.body.querySelector('input[aria-label="Message MoMo"]') as any).placeholder.includes('sends when Studio is back'));
  await m.type('input[aria-label="Message MoMo"]', 'Call Dana');
  await m.submit('form');
  assert.ok(m.text().includes('Call Dana'));
  assert.ok(m.text().includes('Waiting for Studio'));
  await m.click('Move MoMo');
  assert.ok(m.text().includes('Where MoMo runs'));
  await m.click(/^Wake Studio/);
  assert.ok(m.btn('Runs on Studio'));
  assert.equal(m.btn('Wake Studio'), undefined);
  await m.close();
});

test('out of date: Update Studio or Move MoMo instead; signed out: Sign in or use another agent; not installed: Install', async () => {
  const u = await mount('needs-update');
  assert.ok(u.text().includes('MoPilot on Studio is out of date'));
  assert.ok(u.text().includes('It can’t take new work until it is updated. Your notes are safe.'));
  assert.ok(u.text().includes('Takes about a minute. MoPilot restarts on Studio.'));
  await u.click('Move MoMo instead');
  assert.ok(u.text().includes('Where MoMo runs'));
  await u.click('Update Studio');
  assert.equal(u.btn('Update Studio'), undefined);
  await u.close();
  const s = await mount('signed-out');
  assert.ok(s.text().includes('Claude Code is signed out on Studio'));
  assert.ok(s.text().includes('MoMo can’t think until it is signed in. It still notes mail and calendar changes.'));
  assert.ok(s.text().includes('Your password never goes to MoMo.'));
  await s.click('Use another agent');
  assert.equal(s.btn('Sign in on Studio'), undefined);
  await s.close();
  const s2 = await mount('signed-out');
  await s2.click('Sign in on Studio');
  assert.ok(s2.btn('Runs on Studio'));
  await s2.close();
  const n = await mount('not-installed');
  assert.ok(n.text().includes('Claude Code and Codex isn’t installed on Studio'));
  assert.ok(n.btn('Install on Studio'));
  await n.close();
  const refused = await mount('signed-out', 'chat', 'Studio is offline.');
  await refused.click('Sign in on Studio');
  assert.ok(refused.text().includes('Studio is offline.'));
  await refused.close();
  const nameless = scenarioView('signed-out');
  nameless.home.machineName = null;
  nameless.home.agentProblem = null;
  setMomoHomeSeam(createFixtureSeam(nameless, () => NOW));
  resetMomoHomeStore();
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(MomoHomePage, {})));
  await flush();
  assert.ok((window.document.body as any).textContent.includes('The agent is signed out on MoMo’s machine'));
  await act(async () => root.unmount());
  host.remove();
});

test('chat: the brief, the reply with why you were told, the user bubble and Not needed twice with Undo and See rule', async () => {
  const m = await mount(null);
  assert.ok(m.text().includes('Good morning, Du. One thing needs you today: Dana Lee needs the revised Acme quote by Friday.'));
  assert.ok(m.text().includes('From Gmail · “Re: Acme renewal” · Nov 18'));
  assert.ok(m.text().includes('I can move this forward:'));
  assert.ok(m.text().includes('Overnight on Studio: read 38 messages, updated 4 notes, learned 1 rule.'));
  assert.ok(m.text().includes('Gmail · “Re: Acme renewal” · 2 minutes ago · Told you now: client replies'));
  assert.ok(m.text().includes('Yes, it holds. Tell her, and attach the quote.'));
  await m.click('Left out: 1. See');
  assert.ok(m.text().includes('Your Muji package shipped'));
  await m.click('Left out: 1. See');
  await m.click('Not needed');
  assert.ok(m.text().includes('Second time. I will stay quiet about deliveries.'));
  await m.click('See rule');
  assert.deepEqual(nav.pop(), { name: 'momo', tab: 'rules' });
  await m.click('Undo');
  assert.ok(!m.text().includes('Second time.'));
  await m.click('Hide');
  assert.ok(!m.text().includes('I can move this forward:'));
  await m.type('input[aria-label="Message MoMo"]', '   ');
  await m.submit('form');
  await m.type('input[aria-label="Message MoMo"]', 'Thanks');
  await m.submit('form');
  assert.ok(m.text().includes('Thanks'));
  await m.close();
  const s = await mount(null);
  await s.click('Start');
  assert.ok(s.text().includes('Yes, go ahead.'));
  await s.close();
});

test('chat rows the home can send: a quiet-day brief, a catch-up, waiting, and a message that may not have arrived', async () => {
  const v = scenarioView(null);
  v.chat = [
    {
      kind: 'brief',
      id: 'b',
      at: NOW,
      brief: {
        day: 'd',
        greeting: 'Good morning.',
        attention: null,
        offers: [],
        overnight: { read: 1, notesUpdated: 0, rulesLearned: 0 },
        leftOut: [],
      },
    },
    {
      kind: 'catch-up',
      id: 'c',
      at: NOW,
      catchUp: {
        machine: { machineId: 'studio', name: 'Studio' },
        from: NOW - 8_880_000,
        to: NOW,
        read: 14,
        needsYou: [{ id: 'x', text: 'Dana Lee’s reply on Acme' }],
      },
    },
    {
      kind: 'catch-up',
      id: 'c2',
      at: NOW,
      catchUp: { machine: { machineId: 'studio', name: 'Studio' }, from: NOW - 1, to: NOW, read: 0, needsYou: [] },
    },
    { kind: 'waiting', id: 'w', at: NOW, machine: { machineId: 'studio', name: 'Studio' } },
    { kind: 'user', id: 'u1', at: NOW, text: 'First', delivery: 'never-got-it' },
    { kind: 'user', id: 'u2', at: NOW, text: 'Second', delivery: 'not-sure' },
    { kind: 'assistant', id: 'a', at: NOW, text: 'Plain.', source: null, whyTold: null, notNeeded: null },
    { kind: 'assistant', id: 'a3', at: NOW, text: 'Sourced.', source: 'Calendar', whyTold: null, notNeeded: null },
  ];
  setMomoHomeSeam(createFixtureSeam(v, () => NOW));
  resetMomoHomeStore();
  const copied: string[] = [];
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: (t: string) => copied.push(t) }, configurable: true });
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(MomoHomePage, {})));
  await flush();
  const body = window.document.body as any;
  const t = body.textContent as string;
  assert.ok(t.includes('Nothing needs you today.'));
  assert.ok(t.includes('While Studio was asleep,'));
  assert.ok(t.includes('Read 14 messages. 1 needs you: Dana Lee’s reply on Acme. 13 can wait.'));
  assert.ok(t.includes('Read 0 messages. 0 needs you. 0 can wait.'));
  assert.ok(t.includes('Nothing was sent while Studio slept.'));
  assert.ok(t.includes('Waiting for Studio'));
  assert.ok(t.includes('Studio never got it'));
  assert.ok(t.includes('Not sent. Send now?'));
  assert.ok(t.includes('Studio may have started. Check before sending again.'));
  assert.ok(t.includes('MoMo never sends the same message twice on its own.'));
  const btns = (label: string) => [...body.querySelectorAll('button')].filter((b: any) => b.textContent === label) as any[];
  await act(async () => btns('Copy text')[0].click());
  assert.deepEqual(copied, ['First']);
  assert.equal(btns('Send now').length, 1, 'only a message the home never got can be sent again');
  await act(async () => btns('Send now')[0].click());
  await flush();
  assert.equal(body.querySelectorAll('[data-testid^="momo-row-u"]').length, 3, 'sent again under the same id: still one row');
  await act(async () => btns('Check again')[0].click());
  await flush();
  assert.equal(btns('Check again').length, 1);
  await act(async () => root.unmount());
  host.remove();
});

test('the approval card: Send, Edit then Save or Cancel, Don’t send, and the states it shows after', async () => {
  const m = await mount(null);
  assert.ok(m.text().includes('Send this email?'));
  assert.ok(m.text().includes('1 person outside your company'));
  assert.ok(m.text().includes('Dana Lee · dana.lee@acme.example'));
  assert.ok(m.text().includes('Re: Acme renewal'));
  assert.ok(m.text().includes('Acme-quote-200-seats.pdf'));
  assert.ok(m.text().includes('Asked on this Mac and on your iPhone'));
  await m.click('Edit');
  await m.type('textarea[aria-label="Message"]', '');
  assert.equal(m.btn('Save').disabled, true);
  await m.type('textarea[aria-label="Message"]', 'Short version.');
  await m.click('Cancel');
  assert.ok(m.text().includes('Hi Dana, yes, the $48k price holds'));
  await m.click('Edit');
  await m.type('textarea[aria-label="Message"]', 'Short version.');
  await m.click('Save');
  assert.ok(m.text().includes('Short version.'));
  await m.click('Don’t send');
  assert.ok(m.text().includes('Not sent.'));
  await m.click('Ask again');
  await m.click('Send');
  assert.ok(m.text().includes('Sent to Dana Lee.'));
  await m.close();
  const r = await mount(null, 'chat', 'MoMo can’t tell who this goes to, so it won’t send.');
  await r.click('Send');
  assert.ok(r.text().includes('MoMo can’t tell who this goes to, so it won’t send.'));
  await r.close();
});

test('the approval card when it expired, was answered elsewhere, or ended uncertain; one with no outside recipient, subject or attachment', async () => {
  const v = fixtureView();
  const base: any = (v.chat.find((r) => r.kind === 'approval') as any).approval;
  const rows = (a: any) => [{ kind: 'approval' as const, id: 'x', at: NOW, approval: a }];
  const cases: [any, string[]][] = [
    [{ ...base, status: 'pending', expiresAt: NOW - 1 }, ['Expired', 'Nobody answered in 30 minutes. Nothing was done.', 'Ask again']],
    [
      { ...base, answeredElsewhere: { device: 'iPhone', at: NOW, outcome: 'approved' } },
      ['Answered on your iPhone at', 'You sent the email to Dana Lee.'],
    ],
    [{ ...base, answeredElsewhere: { device: 'iPhone', at: NOW, outcome: 'denied' } }, ['You chose not to do it.']],
    [{ ...base, status: 'uncertain' }, ['Not sure this was done.', 'Check Sent in Gmail before trying again.']],
    [
      { ...base, recipients: [{ name: 'Sam', address: 's@x.example', outsideCompany: false }], subject: null, attachments: [] },
      ['Sam · s@x.example'],
    ],
    [{ ...base, recipients: [base.recipients[0], { ...base.recipients[0], address: 'b@x' }] }, ['2 people outside your company']],
    [{ ...base, status: 'completed' }, ['Sent to Dana Lee.']],
    [{ ...base, status: 'approved' }, ['Approved.', 'MoMo is doing it.']],
    [{ ...base, status: 'denied', canAskAgain: true }, ['Not sent.', 'Ask again']],
    [
      { ...base, status: 'failed', failure: { cause: 'Gmail refused it.', fix: { id: 'f1', label: 'Reconnect Gmail' } } },
      ['Couldn’t finish.', 'Gmail refused it.', 'Reconnect Gmail'],
    ],
    [{ ...base, status: 'failed', failure: null }, ['It did not finish.']],
    [{ ...base, status: 'failed', failure: { cause: 'No.', fix: null } }, ['No.']],
    [{ ...base, status: 'rerouted' }, ['This card is rerouted.']],
    [
      {
        ...base,
        action: 'other',
        title: 'Book the room?',
        recipients: [],
        subject: null,
        attachments: [],
        body: 'Book Room 4.',
        fields: [{ label: 'Where', value: 'Room 4' }],
      },
      ['Book the room?', 'Where', 'Room 4', 'Approve', 'Don’t do it'],
    ],
    [{ ...base, action: 'other', status: 'completed' }, ['Done.']],
    [{ ...base, action: 'other', status: 'denied', canAskAgain: false }, ['Not done.']],
    [{ ...base, action: 'other', status: 'uncertain' }, ['Check before trying again.']],
    [{ ...base, action: 'other', answeredElsewhere: { device: 'iPhone', at: NOW, outcome: 'approved' } }, ['You approved it.']],
  ];
  for (const [a, want] of cases) {
    const w = { ...v, chat: rows(a) };
    setMomoHomeSeam(createFixtureSeam(w, () => NOW));
    resetMomoHomeStore();
    const host = window.document.createElement('div');
    window.document.body.appendChild(host as any);
    const root = createRoot(host as any);
    await act(async () => root.render(createElement(MomoHomePage, { now: NOW })));
    await flush();
    const t = (window.document.body as any).textContent as string;
    for (const s of want) assert.ok(t.includes(s), s);
    if (want[0] === 'Expired') {
      await act(async () =>
        [...(window.document.body as any).querySelectorAll('button')].find((b: any) => b.textContent === 'Ask again').click(),
      );
      await flush();
      assert.ok((window.document.body as any).textContent.includes('Send this email?'));
    }
    await act(async () => root.unmount());
    host.remove();
  }
});

test('a machine that is no longer home says where MoMo went and nothing else, not the first-run choice', async () => {
  const v = scenarioView('first-run');
  v.home.movedAway = { machine: { machineId: 'studio', name: 'Studio' }, at: NOW };
  setMomoHomeSeam(createFixtureSeam(v, () => NOW));
  resetMomoHomeStore();
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(MomoHomePage, {})));
  await flush();
  const t = (window.document.body as any).textContent as string;
  assert.ok(t.includes('MoMo moved to Studio at'));
  assert.ok(!t.includes('Where should MoMo live?'));
  await act(async () =>
    [...(window.document.body as any).querySelectorAll('button')].find((b: any) => b.textContent === 'Open Studio').click(),
  );
  assert.deepEqual(nav.pop(), { name: 'settings', section: 'connections', tab: 'other' });
  await act(async () => root.unmount());
  host.remove();
});
