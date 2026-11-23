// The user's turn after a browser hand-off (#1834), over a real BrowserTabs and a real ChatController with no window: Done sends
// "Done on <site>" through the chat's current harness (Codex, Claude Code, ACP), a reply, Stop, a switch or archiving ends it, and
// nothing ever waits on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup as browser, tabOf, drive, recordingCursor } from './support/browser-host-kit.ts';
import { setup as controller, tick } from './support/controller/fixture.ts';

const require = createRequire(import.meta.url);
const { installUserTurns, resumeChat, endHandoff, handoffMoved } = require('../electron/capabilities/browser/userTurn.cjs');
const { CredentialHandoff } = require('../electron/capabilities/browser/credentials.cjs');
const { registerBrowserTools } = require('../electron/capabilities/browser/hostTools.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

/** One chat ('c', the browser kit's) on `family`, its tab on github.com handed to the user, and main's wiring between them. */
function world(t: any, family: string) {
  const ctl = controller();
  ctl.chats.records.set('c', { id: 'c', segments: [{ kind: family, nativeId: 'native' }] });
  const h = browser(t);
  installUserTurns({ controller: ctl.c, browserTabs: h.tabs });
  const tab = tabOf(h);
  tab.wc.url = 'https://github.com/login';
  return { ...ctl, h, tab };
}

/** A browser host whose hand-offs main wired to a controller that sends with `send` (installUserTurns). */
function wired(t: any, send: (chatId: string, text: string) => unknown) {
  const h = browser(t);
  const controller: any = { state: { get: () => ({}), publish: () => {} }, send: (chatId: string, item: any) => send(chatId, item.text) };
  installUserTurns({ controller, browserTabs: h.tabs });
  return h;
}

const TURN: Record<string, string> = { codex: 'turn', claude: 'claude-turn', 'acp:kimi': 'acp-turn' };

for (const family of Object.keys(TURN)) {
  test(`${family}: Done starts the next turn with "Done on <site>" through the chat's harness; a running turn queues it`, async (t) => {
    const w = world(t, family);
    // the agent's turn ended with the hand-off: the chat is idle and the tab is the user's
    w.h.tabs.requestSignin(w.tab, { credential: true });
    assert.equal(w.s('c').turn, 'idle');
    assert.equal(await w.h.tabs.signinDone('c', null), true);
    await tick();
    assert.deepEqual(
      w.execs.map((e) => [e.kind, e.item.text, e.item.opts.human]),
      [[TURN[family], 'Done on github.com', true]],
    );
    assert.equal(w.tab.signin, null);
    // a turn still running when the user is done (another tool, or the agent hasn't ended yet): the message waits its turn
    w.h.tabs.requestSignin(w.tab);
    assert.equal(await w.h.tabs.signinDone('c', w.tab.id), true);
    assert.deepEqual(
      w.s('c').queue.map((q: any) => q.text),
      ['Done on github.com'],
    );
    w.c.end('c');
    await tick();
    assert.deepEqual(w.execs.at(-1)!.item.text, 'Done on github.com');
    assert.equal(w.execs.length, 2);
  });

  test(`${family}: the user's own reply ends the hand-off when it goes to the agent; automatic input and queued input don't`, async (t) => {
    const w = world(t, family);
    w.h.tabs.requestSignin(w.tab);
    // a PR monitor or a peer chat: not the user, the tab stays theirs
    w.c.send('c', { text: 'PR Auto-fix', opts: { human: false } }, null);
    await tick();
    assert.ok(w.tab.signin);
    // typed while that turn runs: queued, so the user hasn't answered the agent yet
    w.c.send('c', { text: 'Passport is E12345678', opts: { human: true } }, null);
    assert.ok(w.tab.signin);
    w.c.end('c');
    await tick();
    assert.equal(w.execs.at(-1)!.item.text, 'Passport is E12345678');
    assert.equal(w.tab.signin, null, 'the reply went to the agent: the tab is its again');
  });

  test(`${family}: Stop, a harness switch or archiving ends the hand-off, with or without a turn`, async (t) => {
    const w = world(t, family);
    w.h.tabs.requestSignin(w.tab);
    // the chat's Stop (onStopped), whatever the harness does with it
    await w.c.stopChat('c').catch(() => {});
    assert.equal(w.tab.signin, null);
    w.h.tabs.requestSignin(w.tab);
    w.state.patch('c', { runningElsewhere: true });
    assert.ok(w.tab.signin, 'other session changes leave it');
    // picking a harness switch (main's session patch, whichever window picked it)
    w.state.patch('c', { pendingSwitch: { to: 'claude' } });
    assert.equal(w.tab.signin, null);
    w.h.tabs.requestSignin(w.tab);
    w.h.tabs.forget('c');
    assert.equal(w.tab.signin, null);
    assert.equal(w.execs.length, 0, 'none of them sends anything');
  });
}

test('installUserTurns: a browser host that is not there or fails never fails the send, the Stop or the patch', async () => {
  const c: any = { beforeDispatch: async () => 'earlier', state: { publish: () => {} } };
  const live: any = { controller: c, browserTabs: null };
  installUserTurns(live);
  assert.equal(await c.beforeDispatch({ chatId: 'c', item: { opts: { human: true } } }), 'earlier');
  c.onStopped('c');
  c.state.publish({ chatId: 'c', patch: { pendingSwitch: {} } });
  c.state.publish({ chatId: 'c' });
  c.state.publish(null);
  await c.beforeDispatch({ chatId: 'c', item: null });
  clearIgnored();
  live.browserTabs = {
    endHandoffs: () => {
      throw new Error('host closing');
    },
  };
  c.onStopped('c');
  assert.deepEqual(
    recentIgnored().map((e: any) => [e.context, e.message]),
    [["end a chat's browser hand-off", 'host closing']],
  );
});

test("resumeChat: the message is a user turn (peer gate first when there is one) and the receipt is the send's", async () => {
  const sent: any[] = [];
  const live: any = { controller: { send: (...a: any[]) => (sent.push(a), { action: 'started' }) } };
  assert.deepEqual(resumeChat(live)('c', 'Done on a.test'), { action: 'started' });
  live.peerRuntime = { userTurn: (chatId: string, item: any) => ({ ...item, id: `u-${chatId}` }) };
  resumeChat(live)('c', 'Done on b.test');
  assert.deepEqual(sent, [
    ['c', { text: 'Done on a.test', attachments: [], opts: { human: true } }, null, true],
    ['c', { text: 'Done on b.test', attachments: [], opts: { human: true }, id: 'u-c' }, null, true],
  ]);
});

test("a move to the user's Chrome with no note, or an end on a tab with no hand-off, changes nothing else", (t) => {
  const h = browser(t);
  const tab = tabOf(h);
  assert.equal(endHandoff(h.tabs, tab, 'done'), null);
  h.tabs.requestSignin(tab);
  assert.equal(handoffMoved(h.tabs, 'c', ''), true);
  assert.equal(tab.signin, null);
  assert.doesNotMatch(h.tabs.state('c'), /changes:/);
});

test('a credential sheet lasts its turn, as approval cards do: the turn end and the chat going end it as stopped (#1834)', async () => {
  const handoff = new CredentialHandoff();
  const view = (chatId: string) => ({
    chatId,
    tabId: 't1',
    origin: 'https://a.test',
    frameOrigin: 'https://a.test',
    reason: '',
    fields: [],
  });
  const mine = handoff.ask(view('c'));
  const other = handoff.ask(view('d'));
  let ended = 0;
  let turnEnd: (chatId: string) => void = () => {};
  const off = registerBrowserTools(
    { register: () => () => {} },
    {
      tabs: { onTurnEnd: (fn: any) => ((turnEnd = fn), () => {}) },
      credentials: handoff,
      grants: {},
      sessions: { end: () => ended++, endAll: () => {} },
      snapshots: { reset: () => {} },
    },
  );
  turnEnd('c');
  assert.deepEqual(await mine.answer, { action: 'stopped' });
  assert.equal(handoff.list().length, 1, "another chat's sheet stays");
  assert.equal(handoff.endChat('c'), 0);
  assert.equal(handoff.endChat('d'), 1);
  assert.deepEqual(await other.answer, { action: 'stopped' });
  assert.equal(ended, 1);
  off();
  // a host with no sheets
  let bare: (chatId: string) => void = () => {};
  registerBrowserTools(
    { register: () => () => {} },
    {
      tabs: { onTurnEnd: (fn: any) => ((bare = fn), () => {}) },
      grants: {},
      sessions: { end: () => {}, endAll: () => {} },
      snapshots: { reset: () => {} },
    },
  );
  bare('c');
});

test('the credential probe never holds the hand-off: a page that does not answer reads as "Your turn" after PROBE_MS', async (t) => {
  const { asksForCredential, PROBE_MS } = require('../electron/capabilities/browser/userTurn.cjs');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hung = asksForCredential({ url: 'https://slow.test/form', send: () => new Promise(() => {}) });
  t.mock.timers.tick(PROBE_MS);
  assert.equal(await hung, false);
  assert.equal(await asksForCredential({ url: 'https://a.test/', send: async () => ({ result: { value: true } }) }), true);
});

test('the credential probe reads every frame session: a password field in a cross-origin sign-in frame is "Sign in to"', async (t) => {
  const { asksForCredential, PROBE_MS } = require('../electron/capabilities/browser/userTurn.cjs');
  const asked: string[] = [];
  // the store page itself has no field; its sign-in frame (another site, its own CDP session) has one
  const tab = (frame: (sid: string) => Promise<any>) => ({
    url: 'https://store.test/signin',
    frames: new Map([
      ['F1', {}],
      ['F2', {}],
    ]),
    send: (_m: string, _p: any, sid: string) => (asked.push(sid), sid ? frame(sid) : Promise.resolve({ result: { value: false } })),
  });
  assert.equal(await asksForCredential(tab(async (sid) => ({ result: { value: sid === 'F2' } }))), true);
  assert.deepEqual(asked, ['', 'F1', 'F2']);
  // a frame that answers without a value, fails or hangs never makes it a sign-in, and never holds the hand-off
  assert.equal(await asksForCredential(tab(async () => ({}))), false);
  assert.equal(await asksForCredential(tab(async () => Promise.reject(new Error('detached')))), false);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hung = asksForCredential(tab(() => new Promise(() => {})));
  t.mock.timers.tick(PROBE_MS);
  assert.equal(await hung, false);
});

test('the credential probe looks into same-origin frames of the page too', () => {
  const { CREDENTIAL_FIELD } = require('../electron/capabilities/browser/userTurn.cjs');
  const doc = (fields: boolean, frames: any[] = []) => ({
    querySelector: () => (fields ? {} : null),
    querySelectorAll: () => frames,
  });
  const run = (document: any) => new Function('document', `return ${CREDENTIAL_FIELD}`)(document);
  assert.equal(run(doc(false)), false);
  assert.equal(run(doc(false, [{ contentDocument: doc(true) }])), true);
  // a cross-origin frame's document can't be read here (its own session is probed instead)
  const blocked = {
    get contentDocument() {
      throw new Error('cross-origin');
    },
  };
  assert.equal(run(doc(false, [blocked, { contentDocument: null }])), false);
  // frames nested in a loop end at a bounded depth
  const loop: any = doc(false);
  loop.querySelectorAll = () => [{ contentDocument: loop }];
  assert.equal(run(loop), false);
});

test("Done on a chat another app is running is refused, not sent past that app's hold", () => {
  const sent: any[] = [];
  const live: any = {
    controller: { state: { get: () => ({ runningElsewhere: true }) }, send: (...a: any[]) => sent.push(a) },
  };
  assert.throws(() => resumeChat(live)('c', 'Done on a.test'), /running in another app/);
  assert.deepEqual(sent, []);
});

test('a hand-off on a held tab is refused without touching its layout; the agent using a tab again forgets an old move', async (t) => {
  const h = browser(t);
  const tab = tabOf(h);
  h.tabs.requestSignin(tab);
  assert.throws(() => h.tabs.requestSignin(tab), { code: 'busy' });
  assert.equal(tab.wc.debugger.sent('Emulation.clearDeviceMetricsOverride').length, 0);
  await h.tabs.signinDone('c', null, false);
  tab.signinMoved = 'The user moved this sign-in to their Chrome';
  await h.tabs.ready(tab, 'c');
  assert.equal(tab.signinMoved, '');
});

test('hand-off (#1834): the tab comes forward and is the user\'s past the turn end; Done sends "Done on <site>" through resume', async (t) => {
  const resumed: [string, string][] = [];
  const h = wired(t, (chatId, text) => void resumed.push([chatId, text]));
  const tab = tabOf(h);
  tab.wc.url = 'https://github.com/login';
  const seen = recordingCursor(h);
  h.log.changes.length = 0;
  h.log.select.length = 0;
  // returns at once: nothing waits on the hold, so the agent's turn can end
  assert.equal(h.tabs.requestSignin(tab, { reason: ' GitHub\nsign-in ', credential: true }), undefined);
  assert.deepEqual(
    [tab.mark, tab.signin.reason, tab.signin.credential, tab.signin.site, h.log.select, seen],
    ['handoff', 'GitHub sign-in', true, 'github.com', [tab.id], [['clear', tab.id, false]]],
  );
  assert.ok(h.log.changes.includes('c'));
  assert.throws(() => h.tabs.requestSignin(tab), { code: 'busy', message: "tab_aaaaaa is already the user's turn." });
  const paused = {
    code: 'signin_pending',
    message: "It is the user's turn on tab_aaaaaa, so agent input to it is paused. Use another tab, or end your turn.",
  };
  await assert.rejects(h.tabs.ready(tab, 'c'), paused);
  // a popup the sign-in opened (OAuth) is the user's with its tab
  const popup = h.tabs.adoptPopup(tab.wc, h.popupWC());
  await assert.rejects(h.tabs.ready(popup, 'c'), paused);
  // the turn ends (the agent's call already returned): the hold and the tab stay, and so does its mark at the next turn end
  await drive(t, h.tabs.turnEnded('c'));
  await drive(t, h.tabs.turnEnded('c'));
  assert.deepEqual([!!tab.signin, tab.closed, tab.mark], [true, false, 'handoff']);
  await assert.rejects(h.tabs.ready(tab, 'c'), paused);
  assert.equal(await h.tabs.signinDone('c', 'tab_other'), false);
  assert.equal(await h.tabs.signinDone('nobody', null), false);
  assert.equal(await h.tabs.signinDone('c', tab.id), true);
  assert.deepEqual(resumed, [['c', 'Done on github.com']]);
  assert.equal(tab.signin, null);
  assert.match(h.tabs.state('c'), /user_done tab_aaaaaa: the user finished on github\.com; read the page again/);
  assert.equal(await h.tabs.signinDone('c', null), false, 'nothing holds any more');
  await drive(t, h.tabs.ready(tab, 'c'));
  // the user gives up (the chat's held tab, by no id): no message, no "done" note; a mark it had stays
  tab.mark = 'deliverable';
  h.tabs.requestSignin(tab);
  assert.equal(tab.mark, 'deliverable');
  assert.equal(tab.signin.credential, false);
  assert.equal(await h.tabs.signinDone('c', null, false), true);
  assert.equal(resumed.length, 1);
  assert.doesNotMatch(h.tabs.state('c'), /user_done/);
  // a reply, a Stop or a harness switch ends every hand-off of the chat at once
  for (const how of ['replied', 'stopped', 'switched'] as const) {
    h.tabs.requestSignin(tab);
    assert.equal(h.tabs.endHandoffs('c', how), 1);
    assert.equal(tab.signin, null);
    assert.equal(h.tabs.endHandoffs('c', how), 0);
  }
});

test("hand-off: a Done whose send fails reports it; the tab is the agent's again and the user can still reply", async (t) => {
  const h = wired(t, () => {
    throw new Error('harness gone');
  });
  const tab = tabOf(h);
  h.tabs.requestSignin(tab);
  await assert.rejects(h.tabs.signinDone('c', null), /harness gone/);
  assert.equal(tab.signin, null);
});

test('hand-off: the tab going or the chat going ends it; a pane that cannot select still hands over', async (t) => {
  const h = browser(t, {
    select: () => {
      throw new Error('window gone');
    },
  });
  const tab = tabOf(h);
  h.tabs.requestSignin(tab);
  assert.ok(tab.signin);
  tab.wc.destroy();
  assert.equal(tab.signin, null);
  const other = tabOf(h, 'tab_bbbbbb');
  h.tabs.requestSignin(other);
  h.tabs.forget('c');
  assert.equal(other.signin, null);
});

test("Done on a host no app wired (another app's browser, a test host) only ends the hand-off: it never sends through another app's chats", async (t) => {
  wired(t, () => assert.fail('sent through another host'));
  const bare = browser(t);
  const tab = tabOf(bare);
  bare.tabs.requestSignin(tab);
  assert.equal(await bare.tabs.signinDone('c', null), true);
  assert.equal(tab.signin, null);
});
