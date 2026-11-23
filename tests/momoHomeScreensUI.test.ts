// MoMo's home surfaces in the renderer, second half (src/components/momo/home): Tasks, Notes, Rules, the brief's settings, the header and a screen that goes away mid-move, on the shared rig (tests/support/momoHomeRig.ts).
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  act,
  createElement,
  createFixtureSeam,
  createRoot,
  fixtureView,
  flush,
  mount,
  MomoHomePage,
  nav,
  NOW,
  resetMomoHomeStore,
  scenarioView,
  setMomoHomeSeam,
  useMomoAct,
  window,
} from './support/momoHomeRig.ts';

test('Tasks groups: Needs you, Working, Watching, Done today; a row opens its detail with done_means; Stop asks first', async () => {
  const m = await mount(null, 'tasks');
  for (const g of ['Needs you 1', 'Working 2', 'Watching 1', 'Done today 3']) assert.ok(m.text().includes(g), g);
  assert.ok(m.text().includes('Send the reply to Dana Lee'));
  assert.ok(m.text().includes('Claude Code · Studio · Draft ready · waiting 3 min'));
  assert.ok(m.text().includes('Codex · Mac mini · Filling the pricing table'));
  await m.click(/^Build the Acme quote sheet/);
  assert.ok(m.text().includes('Done means'));
  assert.ok(m.text().includes('A sheet with 200 seats at $48k'));
  await m.click('Stop');
  assert.ok(m.text().includes('Stop this task?'));
  assert.ok(m.text().includes('The session stops. Files already made are kept.'));
  await m.click('Cancel');
  assert.ok(!m.text().includes('Stop this task?'));
  await m.click('Stop');
  await m.click('Stop');
  assert.ok(m.text().includes('Codex · Mac mini · Stopped'));
  await m.click(/^Build the Acme quote sheet/);
  await m.click(/^Build the Acme quote sheet/);
  await m.click(/^Sort the Downloads folder/);
  assert.ok(m.text().includes('Ready: 214 files sorted. Checked: Downloads has no loose files.'));
  await m.click(/^AWS invoice/);
  assert.ok(m.text().includes('Next check'));
  assert.ok(m.text().includes('Invoice mail from AWS, due today'));
  await m.click('Stop watching');
  assert.ok(!m.text().includes('Watching 1'));
  await m.close();
});

test('failed tasks say the real cause and offer the fix their cause calls for', async () => {
  const m = await mount(null, 'tasks');
  await m.click(/^Export the Q3 report/);
  assert.ok(m.text().includes('Couldn’t finish: Mac mini is out of disk space.'));
  assert.ok(m.btn('Retry'));
  await m.click('Run on another machine');
  assert.ok(m.text().includes('Codex · Studio · Starting again'));
  await m.click(/^Export the Q3 report/);
  await m.click(/^Summarise the vendor contracts/);
  assert.ok(m.text().includes('Codex isn’t installed on Mac mini.'));
  assert.ok(m.btn('Install Codex on Mac mini'));
  assert.ok(m.btn('Run on Studio'));
  await m.click('Install Codex on Mac mini');
  await m.close();
  const codes: [string, string[]][] = [
    ['agent-signed-out', ['Retry', 'Run on Studio']],
    ['machine-unreachable', ['Run on Studio']],
    ['usage-limit', ['Retry', 'Run on Studio']],
    ['unanswered', ['Retry']],
    ['retry-cap', ['Retry', 'Run on another machine']],
    ['restarted', ['Retry', 'Run on another machine']],
    ['not-done', ['Retry', 'Run on Studio']],
  ];
  for (const [code, want] of codes) {
    const v = scenarioView(null);
    const f: any = v.tasks.find((t) => t.id === 't-failed')!;
    f.failure = { code, message: `Cause ${code}.`, machine: null, agent: null, fix: null };
    setMomoHomeSeam(createFixtureSeam(v, () => NOW));
    resetMomoHomeStore();
    const host = window.document.createElement('div');
    window.document.body.appendChild(host as any);
    const root = createRoot(host as any);
    await act(async () => root.render(createElement(MomoHomePage, { tab: 'tasks', now: NOW })));
    await flush();
    const body = window.document.body as any;
    await act(async () => [...body.querySelectorAll('button')].find((b: any) => b.textContent.startsWith('Export the Q3')).click());
    await flush();
    assert.ok(body.textContent.includes(`Cause ${code}.`), code);
    const labels = [...body.querySelectorAll('button')].map((b: any) => b.textContent);
    for (const w of want) assert.ok(labels.includes(w), `${code}: ${w}`);
    await act(async () => root.unmount());
    host.remove();
  }
});

test('Tasks when empty says so and Ask MoMo goes to the chat', async () => {
  const m = await mount('empty', 'tasks');
  assert.ok(m.text().includes('Nothing running.'));
  assert.ok(m.text().includes('Ask MoMo for something that takes a while. It works in the background and comes back with one result.'));
  await m.click('Ask MoMo');
  assert.deepEqual(nav.pop(), { name: 'momo', tab: 'chat' });
  await m.close();
});

test('Notes: list, search, a note with sources and why, edit, history with Undo and Restore, See change, Forget', async () => {
  const m = await mount(null, 'notes');
  for (const s of ['Acme', 'Dana Lee', 'About you', 'You wrote this']) assert.ok(m.text().includes(s), s);
  assert.ok(m.text().includes('Renewal in progress. $48k for 200 seats'));
  assert.ok(m.text().includes('Changed last night: Summary rewritten after the price was confirmed.'));
  await m.click('See change');
  assert.ok(m.text().includes('Acme · History'));
  await m.click('History');
  await m.click('Why MoMo thinks this');
  assert.ok(m.text().includes('“the $48k price holds if we start Dec 1”'));
  assert.ok(m.text().includes('Calendar · “Acme sync”'));
  await m.click('Why MoMo thinks this');
  const whys = [...m.body.querySelectorAll('button')].filter((b: any) => b.textContent === 'Why MoMo thinks this');
  await act(async () => whys[1].click());
  await flush();
  assert.ok(m.text().includes('This message is no longer in Gmail. The quote is kept.'));
  const edits = [...m.body.querySelectorAll('button')].filter((b: any) => b.textContent === 'Edit');
  await act(async () => edits[0].click());
  await flush();
  assert.ok(m.text().includes('Your edit becomes Confirmed. The old text stays in History.'));
  await m.type('textarea[aria-label="Edit line"]', '');
  assert.equal(m.btn('Save').disabled, true);
  await m.type('textarea[aria-label="Edit line"]', 'Renewal agreed at $48k.');
  await m.click('Save');
  assert.ok(m.text().includes('Renewal agreed at $48k.'));
  assert.ok(m.text().includes('Confirmed'));
  const again = [...m.body.querySelectorAll('button')].filter((b: any) => b.textContent === 'Edit');
  await act(async () => again[0].click());
  await flush();
  await m.type('textarea[aria-label="Edit line"]', 'dropped');
  await m.click('Cancel');
  assert.ok(!m.text().includes('dropped'));
  await m.click('History');
  assert.ok(m.text().includes('Acme · History'));
  assert.ok(m.text().includes('Added: Dana needs the revised quote by Friday'));
  await m.click('Restore last night');
  assert.ok(!m.text().includes('Changed last night'));
  const undo = [...m.body.querySelectorAll('button')].filter((b: any) => b.textContent === 'Undo');
  await act(async () => undo[0].click());
  await flush();
  assert.ok(m.text().includes('No changes yet.'));
  await m.click('History');
  await m.type('input[type="search"]', 'dana');
  assert.ok(m.text().includes('Dana Lee'));
  await m.type('input[type="search"]', 'zzz');
  assert.ok(m.text().includes('No notes match.'));
  await m.type('input[type="search"]', '');
  await m.click(/^Dana Lee/);
  assert.ok(m.text().includes('Runs renewals at Acme.'));
  await m.click('Forget');
  assert.ok(m.text().includes('Forget this note? It is deleted, not archived.'));
  await m.click('Cancel');
  await m.click('Forget');
  await m.clickLast('Forget');
  assert.ok(!m.text().includes('Runs renewals at Acme.'));
  await m.close();
  const u = await mount(null, 'notes');
  await u.click('See change');
  await u.click('Undo');
  assert.ok(!u.text().includes('Changed last night'));
  await u.close();
});

test('Notes when empty offer Connect and Write your own; a disconnected source says so with Reconnect and Remove', async () => {
  const e = await mount('empty', 'notes');
  assert.ok(e.text().includes('Nothing here yet.'));
  assert.ok(
    e.text().includes('After you connect Gmail and Calendar, MoMo writes down what it learns. You can read and change every line.'),
  );
  await e.click('Write your own note');
  assert.equal(e.btn('Save').disabled, true);
  await e.click('Cancel');
  await e.click('Write your own note');
  await e.type('input[aria-label="Title"]', 'Plans');
  await e.type('textarea[aria-label="Note"]', 'Move in March.');
  await e.submit('form');
  assert.ok(e.text().includes('Move in March.'));
  await e.close();
  const c = await mount('empty', 'notes');
  await c.click('Connect Gmail and Calendar');
  assert.ok(c.text().includes('Connect Gmail and Calendar'));
  await c.close();
  const g = await mount('source-gone', 'notes');
  assert.ok(g.text().includes('Gmail needs you to sign in again'));
  assert.ok(g.text().includes('Google ended the sign-in. MoMo is not reading new mail. Your notes are kept.'));
  assert.ok(g.text().includes('Removing Gmail can also forget notes learned only from it.'));
  await g.click('Reconnect');
  assert.ok(!g.text().includes('needs you to sign in again'));
  await g.close();
  const r = await mount('source-gone', 'notes');
  await r.click('Remove Gmail');
  assert.ok(!r.text().includes('needs you to sign in again'));
  await r.close();
});

test('Rules: learned, yours and built in with their effect; detail with the reactions; edit, add, turn off and on, signals', async () => {
  const m = await mount(null, 'rules');
  for (const s of [
    'Learned from you',
    'Yours',
    'Built in',
    'Client replies → tell me right away',
    'Deliveries → stay quiet',
    'Sending email → always ask me',
  ])
    assert.ok(m.text().includes(s), s);
  assert.ok(m.text().includes('What MoMo brings you, what it leaves, and what it may do without asking.'));
  assert.ok(m.text().includes('Built in · cannot be turned off'));
  assert.ok(m.text().includes('you answered “Not needed” twice'));
  assert.ok(m.text().includes('you said “when a client replies, tell me right away”'));
  assert.ok(m.text().includes('You added this'));
  assert.ok(m.text().includes('MoMo can make itself quieter on its own. A rule that lets it do more always needs your yes.'));
  assert.ok(m.text().includes('Watching: you opened two newsletters late.'));
  await m.click(/^Deliveries → stay quiet/);
  assert.ok(m.text().includes('Applies toDelivery notices from shops and carriers'));
  assert.ok(m.text().includes('Why it exists'));
  assert.ok(m.text().includes('Your Uniqlo package arrives tomorrow'));
  assert.ok(m.text().includes('Used 7 times since'));
  await m.click('Turn off');
  assert.ok(m.btn('Turn on'));
  await m.click('Turn on');
  await m.click('Edit');
  assert.ok(m.text().includes('A rule that tells you more, or skips a question, needs your tap.'));
  assert.ok(m.text().includes('Still show in the morning brief'));
  await m.type('input:not([type])', 'Shop mail → tell me');
  await m.type('select', 'tell_now');
  await m.type('input[type="checkbox"]', 'on');
  await m.click('Save');
  assert.ok(m.text().includes('Shop mail → tell me'));
  await m.click(/^Shop mail → tell me/);
  await m.click(/^Sending email → always ask me/);
  assert.ok(m.text().includes('Built in. Cannot be turned off.'));
  assert.equal(m.btn('Edit'), undefined);
  await m.click(/^Sending email → always ask me/);
  await m.click('Add a rule');
  await m.type('input:not([type])', '');
  assert.equal(m.btn('Save').disabled, true);
  await m.type('input:not([type])', 'Bills → ask first');
  await m.type('select', 'ask_first');
  await m.submit('form[aria-label="Add a rule"]');
  assert.ok(m.text().includes('Bills → ask first'));
  await m.click('Make it a rule');
  assert.ok(!m.text().includes('Watching: you opened'));
  await m.close();
  const i = await mount(null, 'rules');
  await i.click('Ignore');
  assert.ok(!i.text().includes('Watching: you opened'));
  await i.click('Add a rule');
  await i.click('Cancel');
  await i.click(/^Invoices → tell me/);
  await i.click('Edit');
  await i.click('Cancel');
  await i.close();
});

test('a rule that is only saved says it is not applied yet and can be turned off; one in a state this version does not know says nothing', async () => {
  const v = scenarioView(null);
  v.rules = [
    { ...v.rules[0], id: 'saved', text: 'Quiet on Fridays', origin: 'yours', state: 'saved' },
    { ...v.rules[0], id: 'odd', text: 'From a newer home', origin: 'yours', state: 'paused-by-a-newer-home' },
  ];
  const m = await mountView(v, 'rules');
  const row = (id: string) => m.body.querySelector(`[data-testid="momo-rule-${id}"]`);
  assert.ok(row('saved').textContent.includes('Saved. Not applied yet'));
  assert.ok(!row('saved').textContent.includes('Undone'));
  assert.ok(!row('odd').textContent.includes('Undone'));
  await act(async () => row('saved').click());
  assert.ok([...m.body.querySelectorAll('button')].some((b: any) => b.textContent.trim() === 'Turn off'));
  await m.close();
});

test('Rules when empty say so; a rule that is only suggested or undone can be turned on; a rule with no reactions has no Why section', async () => {
  const e = await mount('empty', 'rules');
  assert.ok(e.text().includes('No rules yet.'));
  assert.ok(e.text().includes('When you answer the same way twice, MoMo suggests a rule here. You can also add your own.'));
  await e.close();
  const v = scenarioView(null);
  v.rules[0].state = 'suggested';
  v.rules[1].state = 'undone';
  v.rules[2].state = 'off';
  v.rules[0].evidence = [{ at: NOW, reaction: 'Not needed', item: 'One' }];
  v.rules[0].origin = 'learned';
  v.rules[3].useCount = 0;
  setMomoHomeSeam(createFixtureSeam(v, () => NOW));
  resetMomoHomeStore();
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(MomoHomePage, { tab: 'rules', now: NOW })));
  await flush();
  const body = window.document.body as any;
  const t = body.textContent as string;
  for (const s of ['Suggested', 'Undone', 'Off', 'you answered “Not needed” once']) assert.ok(t.includes(s), s);
  await act(async () => [...body.querySelectorAll('button')].find((b: any) => b.textContent.startsWith('Client replies')).click());
  await flush();
  await act(async () => [...body.querySelectorAll('button')].find((b: any) => b.textContent === 'Turn on').click());
  await flush();
  assert.ok(body.textContent.includes('Tell now'));
  await act(async () => root.unmount());
  host.remove();
});

test('the brief’s settings rows change only what is touched, and previews say what the lock screen shows', async () => {
  const m = await mount(null, 'rules');
  assert.ok(m.text().includes('A quiet day means no brief and no push.'));
  assert.ok(m.text().includes('The lock screen says “MoMo needs you”.'));
  const boxes = [...m.body.querySelectorAll('input[type="checkbox"]')] as any[];
  await act(async () => boxes[0].click());
  await flush();
  assert.equal(((await m.seam.read()) as any).view.settings.brief.on, false);
  await act(async () => boxes[boxes.length - 1].click());
  await flush();
  assert.ok(m.text().includes('The text is sealed. Apple and the relay only see “MoMo needs you”.'));
  const text = [...m.body.querySelectorAll('input[type="time"]')] as any[];
  for (const [i, v] of [
    [0, '07:00'],
    [1, '21:00'],
    [2, '07:00'],
  ] as const) {
    await act(async () => {
      text[i].value = v;
      text[i].dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
    });
  }
  const cap = m.body.querySelector('input[type="number"]') as any;
  await act(async () => {
    cap.value = '3';
    cap.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
  });
  await flush();
  const s = ((await m.seam.read()) as any).view.settings;
  assert.deepEqual([s.brief.time, s.quietHours.from, s.quietHours.to, s.dailyCap], ['07:00', '21:00', '07:00', 3]);
  await m.close();
});

test('the header moves between the four views, a memory route shows the chat, and before the seam answers nothing is drawn', async () => {
  const m = await mount(null, 'memory');
  assert.equal(m.btn('Chat')?.getAttribute('aria-current'), 'page');
  await m.click('Notes');
  assert.deepEqual(nav.pop(), { name: 'momo', tab: 'notes' });
  await m.close();
  setMomoHomeSeam({ read: () => new Promise(() => undefined), subscribe: () => () => undefined, act: async () => ({ ok: true }) });
  resetMomoHomeStore();
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(MomoHomePage, {})));
  await flush();
  assert.equal(host.textContent, '');
  await act(async () => root.unmount());
  host.remove();
});

test('a screen that went away before its move answered does not touch its state', async () => {
  let release: (r: any) => void = () => undefined;
  const seam = createFixtureSeam(fixtureView(), () => NOW);
  seam.act = () => new Promise((r) => (release = r));
  setMomoHomeSeam(seam);
  resetMomoHomeStore();
  let run: (() => Promise<unknown>) | null = null;
  function Probe() {
    const { act: go } = useMomoAct();
    run = () => go({ type: 'move.cancel' });
    return null;
  }
  const host = window.document.createElement('div');
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(Probe)));
  let pending: Promise<unknown> = Promise.resolve();
  await act(async () => {
    pending = run!();
  });
  await act(async () => root.unmount());
  release({ ok: true });
  assert.deepEqual(await pending, { ok: true });
});

async function mountView(v: ReturnType<typeof fixtureView>, tab: any = 'chat') {
  setMomoHomeSeam(createFixtureSeam(v, () => NOW));
  resetMomoHomeStore();
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(MomoHomePage, { tab, now: NOW })));
  await flush();
  const body = window.document.body as any;
  return {
    body,
    text: () => body.textContent as string,
    click: async (label: string) => {
      await act(async () => [...body.querySelectorAll('button')].find((b: any) => b.textContent.trim() === label).click());
      await flush();
    },
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('delivery problems say their cause and run their fix; a machine that moved away says so; an update names the builds', async () => {
  const v = scenarioView('needs-update');
  v.problems = [
    {
      id: 'push:1',
      code: 'notifications_off',
      cause: 'Notifications are off for MoMo.',
      fix: { id: 'open_settings', label: 'Open Settings' },
      since: NOW,
    },
  ];
  const m = await mountView(v);
  assert.ok(m.text().includes('Notifications are off for MoMo.'));
  assert.ok(m.text().includes('Studio has 0.3.0; it needs 0.4.0.'));
  await m.click('Open Settings');
  assert.ok(!m.text().includes('Notifications are off for MoMo.'));
  await m.close();
  const away = scenarioView(null);
  away.home.movedAway = { machine: { machineId: 'studio', name: 'Studio' }, at: NOW };
  const a = await mountView(away);
  assert.ok(a.text().includes('MoMo moved to Studio at'));
  await a.close();
  const plain = scenarioView('needs-update');
  plain.home.update = null;
  const p = await mountView(plain);
  assert.ok(!p.text().includes('it needs'));
  await p.close();
});

test('values this client does not know are shown as they came and never offer an action', async () => {
  const v = scenarioView(null);
  v.home.move = {
    moveId: 'm',
    from: { machineId: 'studio', name: 'Studio' },
    to: { machineId: 'mac-mini', name: 'Mac mini' },
    step: 'verifying',
    outcome: 'running',
    finishedAt: null,
    failure: null,
    oldMachineOffline: false,
  };
  v.chat = [{ kind: 'user', id: 'u', at: NOW, text: 'Hello', delivery: 'lost-in-space' }];
  const m = await mountView(v);
  assert.equal(
    [...m.body.querySelectorAll('button')].some((b: any) => b.textContent === 'Cancel'),
    false,
  );
  assert.ok(m.text().includes('Not sure'));
  await m.close();
  const t = scenarioView(null);
  t.tasks = [{ ...t.tasks[0], id: 'odd', title: 'Odd one', state: 'paused-by-a-newer-host' }];
  const tm = await mountView(t, 'tasks');
  assert.ok(tm.text().includes('Other 1'));
  assert.ok(tm.text().includes('Odd one'));
  await tm.close();
  const n = scenarioView('source-gone');
  n.home.sources = [{ id: 'drive', account: 'a', access: 'read-only', status: 'needs-reconnect', progress: null }];
  n.notes[0].lines[0].status = 'archived-by-a-newer-host';
  const nm = await mountView(n, 'notes');
  assert.ok(nm.text().includes('drive needs you to sign in again'));
  assert.ok(nm.text().includes('archived-by-a-newer-host'));
  await nm.close();
});

test('the page says where MoMo runs now after it refused an answer from an old home', async () => {
  const { noteStale, clearStale } = await import('../src/components/momo/home/staleNote.ts');
  const m = await mountView(scenarioView(null));
  assert.ok(!m.text().includes('now.'));
  await act(async () => noteStale());
  assert.ok(m.text().includes('MoMo runs on'));
  await act(async () => clearStale());
  assert.ok(!m.text().includes('MoMo runs on'));
  await m.close();
});
