// The control matrix (docs/control-plane/matrix.md), stream Y: Your Chrome and Claude in Chrome reliability until
// MoPilot's own extension ships (design D5). Your Chrome: a JavaScript dialog or file chooser no longer blocks
// the chat; a chat's instance (its tab group) is never stopped while a call, its card or the chat's turn runs; a
// call that never answered is cancelled; the chat says when Chrome waits for the user's approval; a new profile or
// token waits for a running chat. Claude in Chrome: Settings counts and moves only a chat's current segment, a
// browser switch waits for a running turn, an idle CLI that holds the chat's pages is kept longer, and quitting
// gives the CLIs time to close their tab groups. ChromeChannel and the Claude sessions are real (over a fake
// Playwright child and a fake Agent SDK); Chrome and the CLIs are fakes.
import { scriptedChrome as playwright } from './support/extension-wire.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pickStrip } from '../src/lib/statusStrip.ts';
import { chromeSuggestion } from '../src/harness/chromeApproval.ts';
import { tmp, DIALOG, setHoldTurns, claude, ipc, until, tick, opened, claudeChrome, groupHolds } from './support/claude-chrome-kit.ts';

export const GUARDS = ['electron/', 'shared/', 'src/'];

const require = createRequire(import.meta.url);
const {
  ChromeChannel,
  PlaywrightInstance,
  chromeTools,
  spawnSpec,
  modalStates,
} = require('../electron/capabilities/browser/extension.cjs');
const { cleanupHold } = require('../electron/platform/exitGate.cjs');
const { SessionStore } = require('../electron/session/state.cjs');

/* ---------- Your Chrome: a fake @playwright/mcp child behind the real ChromeChannel ---------- */

const PAGE = (url: string) => `### Page\n- Page URL: ${url}`;
const DIALOG_STATE = '### Modal state\n- ["confirm" dialog with message "Leave site?"]: can be handled by browser_handle_dialog';
const CHOOSER_STATE = '### Modal state\n- [File chooser]: can be handled by browser_file_upload';
const refused = (name: string) => `### Error\nError: Tool "${name}" does not handle the modal state.`;

/**
 * A page in the user's Chrome as @playwright/mcp shows it: `modal` is an open dialog or file chooser, which makes
 * every other tool fail (coreBundle.js defineTabTool) until browser_handle_dialog (or browser_file_upload) clears it.
 */
function chromePage() {
  const page = {
    url: 'https://shop.test/cart',
    modal: null as null | 'dialog' | 'chooser',
    calls: [] as any[],
    hold: null as Promise<void> | null,
  };
  const answer = (name: string, args: any) => {
    page.calls.push([name, args]);
    const state = page.modal === 'dialog' ? DIALOG_STATE : page.modal === 'chooser' ? CHOOSER_STATE : '';
    const handles =
      (page.modal === 'dialog' && name === 'browser_handle_dialog') || (page.modal === 'chooser' && name === 'browser_file_upload');
    if (page.modal && !handles) return { isError: true, content: [{ type: 'text', text: `${refused(name)}\n${state}` }] };
    if (!page.modal && name === 'browser_handle_dialog')
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: '### Error\nError: The tool "browser_handle_dialog" can only be used when there is related modal state present.',
          },
        ],
      };
    if (handles) page.modal = null;
    if (name === 'browser_click' && args?.element === 'Delete') page.modal = 'dialog';
    const after = page.modal === 'dialog' ? `\n${DIALOG_STATE}` : '';
    return { content: [{ type: 'text', text: `${PAGE(page.url)}${after}` }] };
  };
  return { page, answer };
}

const SCHEMAS = ['browser_snapshot', 'browser_click', 'browser_handle_dialog'].map((name) => ({
  name,
  inputSchema: { type: 'object', properties: {} },
}));
const ctx = (chatId = 'chat-y', signal = new AbortController().signal) => ({ chatId, segmentId: 's1', signal });
/** Grants that allow everything; `card` makes the write card wait until it is answered. */
function grants() {
  const g: any = { card: null as Promise<void> | null, asked: [] as string[] };
  g.require = async () => {};
  g.act = async (_url: string, _ctx: any, o: any) => {
    g.asked.push(o.tool);
    await g.card;
  };
  return g;
}
function yourChrome(
  o: { idleMs?: number; callMs?: number; approvalMs?: number; token?: string; busy?: (id: string) => boolean; onCall?: any } = {},
) {
  const pw = playwright(o.onCall);
  const approvals: Array<[string, boolean]> = [];
  const channel = new ChromeChannel({
    fork: pw.fork,
    spec: () => spawnSpec({ outputDir: tmp, env: {}, token: o.token ?? 'tok' }),
    idleMs: o.idleMs ?? 30,
    callMs: o.callMs,
    approvalMs: o.approvalMs,
    busy: o.busy,
    onApproval: (chatId: string, waiting: boolean) => approvals.push([chatId, waiting]),
  });
  const g = grants();
  const tools = Object.fromEntries(chromeTools({ channel, grants: g, schemas: SCHEMAS }).map((t: any) => [t.name, t]));
  const call = (name: string, args: any = {}, chatId = 'chat-y', signal?: AbortSignal) =>
    tools[`sage_browser_${name}`].handler(args, ctx(chatId, signal));
  return { channel, pw, g, call, approvals };
}

/* ====================================================================== */
/* Your Chrome: dialogs and file choosers                                 */
/* ====================================================================== */

test('CM-Y01a: a JavaScript dialog no longer blocks the chat: writes name sage_browser_handle_dialog, which answers it without a snapshot first', async () => {
  const { page, answer } = chromePage();
  const y = yourChrome({ onCall: answer });
  await y.call('snapshot');
  page.modal = 'dialog';
  // every other tool is refused by Playwright; the agent is told what is open and what to call here
  await assert.rejects(y.call('click', { element: 'Buy' }), (e: any) => {
    assert.equal(e.code, 'modal_open');
    assert.match(e.message, /"confirm" dialog with message "Leave site\?"/);
    assert.match(e.message, /sage_browser_handle_dialog/);
    assert.doesNotMatch(e.message, /\bbrowser_handle_dialog\b(?<!sage_browser_handle_dialog)/);
    return true;
  });
  await assert.rejects(y.call('snapshot'), (e: any) => e.code === 'modal_open' && /sage_browser_handle_dialog/.test(e.message));
  // handle_dialog reaches Playwright: no snapshot first, the site's write permission and card still apply
  page.calls.length = 0;
  const out = await y.call('handle_dialog', { accept: false });
  assert.deepEqual(
    page.calls.map((c: any) => c[0]),
    ['browser_handle_dialog'],
  );
  assert.deepEqual(y.g.asked.at(-1), 'handle_dialog');
  assert.equal(page.modal, null);
  assert.match(out.content[0].text, /Page URL/);
  // and the page works again
  await y.call('click', { element: 'Buy' });
  // a handle_dialog with nothing open is Playwright's own error
  await assert.rejects(y.call('handle_dialog', { accept: true }), /can only be used when there is related modal state/);
  await y.channel.stopAll();
});

test('CM-Y01b: a file chooser is cancelled with handle_dialog accept false; accepting it is refused, nothing is uploaded', async () => {
  const { page, answer } = chromePage();
  const y = yourChrome({ onCall: answer });
  await y.call('snapshot');
  page.modal = 'chooser';
  await assert.rejects(
    y.call('click', { element: 'Next' }),
    (e: any) => e.code === 'modal_open' && /accept: false to cancel/.test(e.message),
  );
  await assert.rejects(
    y.call('handle_dialog', { accept: true }),
    (e: any) => e.code === 'modal_open' && /does not upload files/.test(e.message),
  );
  assert.equal(page.modal, 'chooser');
  await y.call('handle_dialog', { accept: false });
  assert.deepEqual(page.calls.at(-1), ['browser_file_upload', {}], 'cancelled: no paths');
  assert.equal(page.modal, null);
  await y.channel.stopAll();
});

test('CM-Y01c: an action that opens a dialog tells the agent how to answer it; modalStates reads only the modal section', async () => {
  const { answer } = chromePage();
  const y = yourChrome({ onCall: answer });
  await y.call('snapshot');
  const out = await y.call('click', { element: 'Delete' });
  assert.match(out.content.at(-1).text, /^Chrome is showing "confirm" dialog .* call sage_browser_handle_dialog/);
  assert.deepEqual(modalStates([{ type: 'text', text: `${DIALOG_STATE}\n### Snapshot\n- [x]: can be handled by y` }]), [
    { description: '"confirm" dialog with message "Leave site?"', tool: 'browser_handle_dialog' },
  ]);
  assert.deepEqual(modalStates([{ type: 'image' }, { type: 'text', text: '### Modal state\n- There is no modal state present' }]), []);
  // a handle_dialog before any page is known can't be checked against a site
  const fresh = yourChrome({ onCall: answer });
  await assert.rejects(fresh.call('handle_dialog', { accept: true }), (e: any) => e.code === 'bad_args');
  await y.channel.stopAll();
  await fresh.channel.stopAll();
});

/* ====================================================================== */
/* Your Chrome: the chat's instance outlives slow cards, turns and sign-in */
/* ====================================================================== */

test("CM-Y02a: a card that waits longer than the idle time keeps the chat's instance; it ends only after the call and the idle time", async () => {
  const y = yourChrome({ idleMs: 20 });
  await y.call('snapshot');
  let answer = () => {};
  y.g.card = new Promise<void>((r) => (answer = r));
  const click = y.call('click', { element: 'Pay' });
  await tick(80);
  assert.equal(y.channel.has('chat-y'), true, 'the card is still open: the instance (and its tab group) stays');
  assert.equal(y.pw.children[0].stopped, false);
  answer();
  await click;
  assert.equal(y.channel.has('chat-y'), true);
  await until('the idle stop', () => !y.channel.has('chat-y'));
  assert.equal(y.pw.children[0].stopped, true);
});

test("CM-Y02b: while the chat's turn runs its instance stays; the turn's end starts the idle time", async () => {
  let running = true;
  const y = yourChrome({ idleMs: 20, busy: () => running });
  await y.call('snapshot');
  await tick(80);
  assert.equal(y.channel.has('chat-y'), true, 'a turn between calls (the model thinking, a sign-in) keeps it');
  running = false;
  y.channel.turnEnded('chat-y');
  assert.equal(y.channel.has('chat-y'), true, 'the turn end starts the idle time, it does not stop it');
  await until('the idle stop', () => !y.channel.has('chat-y'));
  y.channel.turnEnded('chat-y'); // no instance: nothing to do
  // after "Continue in Chrome" the instance waits longer for the user to sign in, even past the end of the turn
  await y.channel.instance('chat-y', { idleMs: 10_000 });
  y.channel.turnEnded('chat-y');
  await tick(80);
  assert.equal(y.channel.has('chat-y'), true, 'the sign-in wait outlasts the turn');
  // the agent's next call goes back to the usual idle time
  await y.call('snapshot');
  await until('the idle stop', () => !y.channel.has('chat-y'));
});

test('CM-Y02c: archiving or clearing a chat ends its instance once its call and turn end, never in the middle', async () => {
  let running = true;
  const y = yourChrome({ idleMs: 10_000, busy: () => running });
  await y.call('snapshot');
  let answer = () => {};
  y.g.card = new Promise<void>((r) => (answer = r));
  const click = y.call('click', { element: 'Pay' });
  await tick();
  assert.equal(y.channel.release('chat-y'), false, 'a call is in flight');
  assert.deepEqual(y.channel.releasing(), [], 'not waiting for a new profile or token');
  answer();
  await click;
  assert.equal(y.channel.has('chat-y'), true, 'the turn still runs');
  running = false;
  y.channel.turnEnded('chat-y');
  assert.equal(y.channel.has('chat-y'), false);
  await until('the CLI to stop', () => y.pw.children[0].stopped);
  // idle: it ends at once; a chat without one has nothing to release
  await y.call('snapshot', {}, 'chat-z');
  assert.equal(y.channel.release('chat-z'), true);
  assert.equal(y.channel.release('nobody'), false);
});

test('CM-Y02d: a call that never answers is cancelled and its instance let go, so it can never run later', async () => {
  // instances start with the default call timeout: a real 20 ms one could pass before the fake answers initialize on
  // a busy machine. The call that never answers gets the short one.
  const y = yourChrome();
  await y.call('snapshot');
  (await y.channel.instance('chat-y')).callMs = 20;
  y.pw.o.silent = true;
  await assert.rejects(y.call('snapshot'), /didn't answer tools\/call in time\. It was cancelled/);
  const child = y.pw.children[0];
  const cancel = child.got.find((m: any) => m.method === 'notifications/cancelled');
  assert.equal(cancel.params.requestId, child.got.filter((m: any) => m.method === 'tools/call').at(-1).id);
  await until('the instance to go', () => !y.channel.has('chat-y'));
  assert.equal(child.stopped, true);
  // the next call reconnects on a new instance
  y.pw.o.silent = false;
  await y.call('snapshot');
  assert.equal(y.pw.children.length, 2);
  await y.channel.stopAll();
  // a CLI whose channel already closed is still let go
  const r = playwright();
  const inst = new PlaywrightInstance({ fork: r.fork, spec: spawnSpec({ outputDir: tmp, env: {} }), clientName: 'c' });
  await inst.start();
  inst.callMs = 10;
  r.o.silent = true;
  const post = r.children[0].postMessage;
  r.children[0].postMessage = (m: any) => {
    if (String(m.data).includes('notifications/cancelled')) throw new Error('channel closed');
    post(m);
  };
  await assert.rejects(inst.request('tools/call', {}), /in time/);
});

test('CM-Y02e: without a token, a call waiting for the connection asks the user in the chat to approve it in Chrome', async () => {
  const y = yourChrome({ token: '', approvalMs: 10 });
  // Chrome approves only once the chat was asked: a gate on a timer could open first on a busy machine
  const approve = opened();
  y.pw.o.gate = approve.promise;
  const first = y.call('snapshot');
  await until('the chat to say so', () => y.approvals.length === 1);
  assert.deepEqual(y.approvals, [['chat-y', true]]);
  approve.resolve();
  await first;
  assert.deepEqual(y.approvals.at(-1), ['chat-y', false], 'approved: the strip goes');
  // connected now: a slow call is not an approval
  y.pw.o.gate = tick(40);
  await y.call('snapshot');
  assert.equal(y.approvals.length, 2);
  // the instance goes while the user still hasn't approved: the strip goes with it
  y.pw.o.gate = new Promise(() => {});
  const z = yourChrome({ token: '', approvalMs: 5 });
  z.pw.o.gate = new Promise(() => {});
  void z.call('snapshot').catch(() => {});
  await until('the ask', () => z.approvals.length === 1);
  await z.channel.stopAll();
  assert.deepEqual(z.approvals.at(-1), ['chat-y', false]);
  // a CLI still starting when the call begins: the chat is told once it waits on Chrome
  const slow = yourChrome({ token: '', approvalMs: 5 });
  const started = opened();
  const approved = opened();
  slow.pw.o.startGate = started.promise;
  slow.pw.o.gate = approved.promise;
  const call = slow.call('snapshot');
  await tick(20);
  assert.deepEqual(slow.approvals, [], 'still starting: Chrome has not asked yet');
  started.resolve();
  await until('the chat to be asked once the CLI waits on Chrome', () => slow.approvals.length === 1);
  approved.resolve();
  await call;
  assert.deepEqual(slow.approvals, [
    ['chat-y', true],
    ['chat-y', false],
  ]);
  await slow.channel.stopAll();
  // with a saved token Chrome never asks
  const t = yourChrome({ approvalMs: 1 });
  t.pw.o.gate = tick(30);
  await t.call('snapshot');
  assert.deepEqual(t.approvals, []);
  await y.channel.stopAll();
  await t.channel.stopAll();
  // the strip: below a pending card, above everything else of lower rank
  assert.equal(pickStrip({ approval: true, chromeApproval: true }), 'approval');
  assert.equal(pickStrip({ chromeApproval: true, appControl: true, chromeLink: true }), 'chromeApproval');
  const store = new SessionStore();
  assert.equal(store.get('c').chromeApproval, false);
  assert.equal(store.running('c'), false);
  store.patch('c', { turn: 'awaitingUser' });
  assert.equal(store.running('c'), true);
  assert.equal(store.running('other'), false);
});

/* ====================================================================== */
/* Global changes wait for running chats                                  */
/* ====================================================================== */

test("CM-Y03a: a new Chrome profile or token ends idle instances now, and a working chat's only after its turn", async () => {
  const busy = new Set(['chat-busy']);
  const y = yourChrome({ idleMs: 10_000, busy: (id) => busy.has(id) });
  await y.call('snapshot', {}, 'chat-idle');
  await y.call('snapshot', {}, 'chat-busy');
  assert.deepEqual(y.channel.restartAll(), ['chat-busy']);
  assert.equal(y.channel.has('chat-idle'), false);
  assert.equal(y.channel.has('chat-busy'), true);
  // its next call in the same turn still works in its tab group
  await y.call('snapshot', {}, 'chat-busy');
  assert.equal(y.channel.has('chat-busy'), true);
  busy.clear();
  y.channel.turnEnded('chat-busy');
  assert.equal(y.channel.has('chat-busy'), false);
  assert.deepEqual(y.channel.releasing(), []);
});

test('CM-Y03b: picking another browser for Claude in Chrome moves an idle chat now and a working one when its turn ends', async () => {
  claude.setChromeScope(() => true);
  const idle = await claudeChrome('y03-idle', 'chat-y03-idle');
  setHoldTurns(true);
  const busy = await claudeChrome('y03-busy', 'chat-y03-busy');
  setHoldTurns(false);
  try {
    const out = await claude.chromeSelect('b2');
    assert.deepEqual(idle.q.selected, ['b2']);
    assert.deepEqual(busy.q.selected, [], 'the running turn keeps its browser');
    assert.deepEqual(out.map((r: any) => [r.chatId, !!r.deferred]).sort(), [
      ['chat-y03-busy', true],
      ['chat-y03-idle', false],
    ]);
    busy.q.push({ type: 'result', subtype: 'success' });
    await until('the switch after the turn', () => busy.q.selected.length === 1);
    assert.deepEqual(busy.q.selected, ['b2']);
  } finally {
    await ipc('claude:control', idle.key, 'close');
    await ipc('claude:control', busy.key, 'close');
  }
});

/* ====================================================================== */
/* Claude in Chrome: Settings sees each chat's current segment only        */
/* ====================================================================== */

test("CM-Y04: Settings counts and reconnects only sessions a chat's current Claude segment runs, not a switched chat's leftover CLI", async () => {
  const current = await claudeChrome('y04-current', 'chat-y04');
  const leftover = await claudeChrome('y04-old', 'chat-y04-switched');
  // main's segment scope: chat-y04-switched now runs on Codex, so its earlier Claude CLI is not its chat's
  claude.setChromeScope((chatId: string) => chatId === 'chat-y04');
  try {
    current.q.dialog = { ...DIALOG, connected: false };
    leftover.q.dialog = { ...DIALOG, connected: false };
    const links = await claude.chromeLinks(true);
    assert.deepEqual(
      links.map((l: any) => l.chatId),
      ['chat-y04'],
    );
    const out = await claude.chromeReconnect(null);
    assert.deepEqual(
      out.map((r: any) => r.chatId),
      ['chat-y04'],
    );
    assert.ok(current.q.log.includes('reconnect'));
    assert.ok(!leftover.q.log.includes('reconnect'), "Reconnect leaves a switched chat's leftover CLI alone");
  } finally {
    claude.setChromeScope(() => true);
    await ipc('claude:control', current.key, 'close');
    await ipc('claude:control', leftover.key, 'close');
  }
});

test('CM-Y05b: an edited message or a moved account restarts the CLI gracefully (its exit hooks run); "for this session" says a restart drops it', async () => {
  const { key, q } = await claudeChrome('y05b', 'chat-y05b');
  const r = await claude.send(
    key,
    { bin: process.execPath, sessionId: 'y05b', resume: true, cwd: tmp, account: 'other', chatId: 'chat-y05b' },
    { role: 'user', content: 'again' },
  );
  assert.ok(r !== undefined);
  assert.deepEqual(q.log.slice(0, 2), ['eof', 'exit hooks'], 'the old CLI ran its exit hooks before it was closed');
  await ipc('claude:control', key, 'close');
  const hint = chromeSuggestion([
    { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'mcp__claude-in-chrome__navigate' }] },
  ]);
  assert.match(hint!.hint, /until this chat's Claude Code process restarts/);
  assert.equal(
    chromeSuggestion([{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [] }])!.hint,
    'Claude Code keeps this permission in this project',
  );
});

/* ====================================================================== */
/* Quitting gives the CLIs time to close their tab groups                 */
/* ====================================================================== */

test('CM-Y06: quitting waits (bounded) for the Claude Code and Your Chrome CLIs to exit, so they close their Chrome tab groups', async () => {
  const { q } = await claudeChrome('y06', 'chat-y06');
  groupHolds(q, 't1', ['https://shop.test/cart']);
  setHoldTurns(true);
  const working = await claudeChrome('y06-busy', 'chat-y06-busy');
  setHoldTurns(false);
  const y = yourChrome();
  await y.call('snapshot');
  const done = claude.closeAll(200);
  await y.channel.stopAll();
  await done;
  assert.deepEqual(q.log, ['eof', 'exit hooks', 'close'], 'the CLI ran its exit hooks before it was closed');
  assert.deepEqual(working.q.log, ['interrupt', 'eof', 'exit hooks', 'close'], 'a running turn is interrupted first');
  assert.equal(y.pw.children[0].stopped, true);
  // the hold: the first quit waits for the cleanup, further quits while waiting too, then one goes through
  const quits: string[] = [];
  let finish = () => {};
  const hold = cleanupHold(1000, { defer: (fn: () => void) => fn() });
  const e = {
    prevented: 0,
    preventDefault() {
      this.prevented++;
    },
  };
  assert.equal(
    hold(
      e,
      () => [new Promise<void>((r) => (finish = r))],
      () => quits.push('quit'),
    ),
    true,
  );
  assert.equal(
    hold(
      e,
      () => assert.fail('runs once'),
      () => quits.push('again'),
    ),
    true,
  );
  assert.equal(e.prevented, 2);
  finish();
  await tick();
  assert.deepEqual(quits, ['quit']);
  assert.equal(
    hold(
      e,
      () => [],
      () => {},
    ),
    false,
    'the next quit goes through',
  );
  // a cleanup that hangs is cut off; one that throws at once doesn't hold the quit
  const late: string[] = [];
  cleanupHold(10)(
    e,
    () => [new Promise(() => {})],
    () => late.push('quit'),
  );
  cleanupHold(10)(
    e,
    () => {
      throw new Error('gone');
    },
    () => late.push('threw'),
  );
  await until('both quits', () => late.length === 2);
  assert.deepEqual(late.sort(), ['quit', 'threw']);
});

/* ====================================================================== */
/* Guard: no instance is stopped while a call is in flight                 */
/* ====================================================================== */

test('CM-Y07: invariant: no idle timer, turn end, release or restart stops an instance while one of its calls is in flight', async () => {
  const y = yourChrome({ idleMs: 5 });
  await y.call('snapshot');
  let answer = () => {};
  y.g.card = new Promise<void>((r) => (answer = r));
  const calls = [y.call('click', { element: 'A' }), y.call('click', { element: 'B' })];
  await tick();
  for (const poke of [
    () => tick(30),
    () => y.channel.turnEnded('chat-y'),
    () => y.channel.release('chat-y'),
    () => y.channel.restartAll(),
  ]) {
    await poke();
    assert.equal(y.channel.has('chat-y'), true);
    assert.equal(y.pw.children[0].stopped, false);
  }
  answer();
  await Promise.all(calls);
  // released while held: it ends once the last call ends
  assert.equal(y.channel.has('chat-y'), false);
  await until('the CLI to stop', () => y.pw.children[0].stopped);

  // a stopped call keeps nothing alive, even while its handler still waits on a card (R's stop guard)
  const z = yourChrome({ idleMs: 10_000 });
  await z.call('snapshot');
  let answerZ = () => {};
  z.g.card = new Promise<void>((r) => (answerZ = r));
  const stop = new AbortController();
  const stopped = z.call('click', { element: 'Pay' }, 'chat-y', stop.signal);
  await tick();
  assert.equal(z.channel.release('chat-y'), false, 'held by the live call');
  stop.abort('stopped');
  assert.equal(z.channel.has('chat-y'), false, 'the stopped call let go at once');
  answerZ();
  await assert.rejects(stopped, /Stopped by the user/);
  await until('the CLI to stop', () => z.pw.children[0].stopped);
  // a stopped call is never shown as waiting for Chrome's approval
  const a = yourChrome({ token: '', approvalMs: 5 });
  a.pw.o.gate = new Promise(() => {});
  const stopA = new AbortController();
  stopA.abort('stopped');
  await assert.rejects(a.call('snapshot', {}, 'chat-y', stopA.signal), /Stopped by the user/);
  await tick(20);
  assert.deepEqual(a.approvals, []);
  await a.channel.stopAll();
});
