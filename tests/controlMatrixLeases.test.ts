// The control matrix, group T (docs/control-plane/matrix.md): TargetLeases. Every target an agent holds is a lease
// keyed by the MoPilot chat id (the built-in browser's pane tabs, Your Chrome's tab group, the desktop lock, app locks),
// whichever harness or segment took it. Marks decide at the turn end whether a tab is kept, released or closed; the
// turn end sweeps every surface of the chat, each bounded; a switch's handoff record lists what the chat holds.
// Real: TargetLeases, turnLedger (turnEnd.cjs), BrowserTabs (browser-host-kit), ChromeChannel, setupComputerUse,
// SwitchRunner over the real ChatsStore (control-matrix-kit). Fake: Electron, the helper app, Chrome, the harnesses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { switchingChat, world } from './support/control-matrix-kit.ts';
import { drive, flush, setup as browserHost, tabOf } from './support/browser-host-kit.ts';

export const GUARDS = ['electron/', 'shared/'];

const require = createRequire(import.meta.url);
const { TargetLeases, leaseOutcome, RELEASE_MS } = require('../electron/capabilities/targetLeases.cjs');
const { turnLedger } = require('../electron/capabilities/turnEnd.cjs');
const { ChromeChannel } = require('../electron/capabilities/browser/extension.cjs');
const { setupComputerUse } = require('../electron/capabilities/computerUse.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { heldText, composeHandoff } = require('../shared/handoff.mjs');

const SECRET = 'tok_9f8e7d';
const quiet = (t: any) => t.mock.method(console, 'debug', () => {});

/** The ledger as electron/app/sessions.cjs builds it, over a TargetLeases with these surfaces. */
function ledgerOver(surfaces: any[], o: { chatOf?: (id: string) => string; running?: (id: string) => boolean } = {}) {
  const leases = new TargetLeases({ surfaces });
  const aborted: string[] = [];
  const ledger = turnLedger({
    steps: leases.steps,
    abortChat: (chatId: string, why: string) => aborted.push(`${chatId} ${why}`),
    chatOf: o.chatOf ?? ((id: string) => id),
    running: o.running ?? (() => false),
    tracked: () => true,
  });
  return { leases, ledger, aborted };
}

/** A surface that records each turn end it is asked for. */
const recording = (name: string, log: string[], turnEnded: (chatId: string) => unknown = () => {}) => ({
  name,
  leases: () => [],
  turnEnded: (chatId: string) => (log.push(`${name} ${chatId}`), turnEnded(chatId)),
});

/** setupComputerUse as main wires it, with nothing launched. */
function computerUse() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-matrix-leases-'));
  return setupComputerUse({
    ipcMain: { handle() {} },
    registry: new Registry(),
    flags: { isEnabled: () => true },
    chats: { records: new Map(), get: () => null, patchMeta: () => true },
    controller: { chatOf: (id: string) => id, ref: () => ({ kind: 'claude' }), viewing: () => true, isSubagentCall: () => false },
    sessions: { get: () => null, patch: () => {} },
    userData: dir,
    packaged: false,
    broadcast: () => {},
    stop: async () => {},
  });
}

test("CM-T01: marks decide the turn end: an unmarked agent tab closes, a hand-off is kept, a deliverable, the user's or a taken-over tab is released", async (t) => {
  // the rule itself
  assert.equal(leaseOutcome({ origin: 'agent' }), 'close');
  assert.equal(leaseOutcome({ origin: 'agent', mark: 'handoff' }), 'keep');
  assert.equal(leaseOutcome({ origin: 'agent', mark: 'deliverable' }), 'release');
  assert.equal(leaseOutcome({ origin: 'agent', takenOver: true }), 'release');
  assert.equal(leaseOutcome({ origin: 'user' }), 'release');
  assert.equal(leaseOutcome({ origin: 'user', mark: 'handoff' }), 'keep');
  // the pane applies it, whichever harness drove the tabs (browser_* on Claude Code, Codex and ACP, the Codex plugin)
  const h = browserHost(t, { attachMs: 1000 });
  const users = tabOf(h, null);
  const scratch = await drive(t, h.tabs.create('c'));
  const handoff = await drive(t, h.tabs.create('c'));
  const deliverable = await drive(t, h.tabs.create('c'));
  const taken = await drive(t, h.tabs.create('c'));
  const last = await drive(t, h.tabs.create('c'));
  h.tabs.mark('c', handoff.id, 'handoff');
  h.tabs.mark('c', deliverable.id, 'deliverable');
  h.tabs.takeOver('c', taken.id);
  await drive(t, h.tabs.ready(last, 'c'));
  const before = Object.fromEntries(h.tabs.leases('c').map((l: any) => [l.id, leaseOutcome(l)]));
  assert.deepEqual(before, {
    [users.id]: 'release',
    [scratch.id]: 'close',
    [handoff.id]: 'keep',
    [deliverable.id]: 'release',
    [taken.id]: 'release',
    [last.id]: 'close',
  });
  const { closed, kept } = await drive(t, h.tabs.turnEnded('c'));
  // what the rule closes goes, except the tab the agent finished on, kept as the turn's result
  assert.deepEqual(closed, [scratch.id]);
  assert.deepEqual(kept.sort(), [users.id, handoff.id, deliverable.id, taken.id, last.id].sort());
  // after the turn every kept tab is the chat's to keep: none closes at the next turn end
  assert.ok(h.tabs.leases('c').every((l: any) => l.origin === 'user' && leaseOutcome(l) !== 'close'));
  assert.deepEqual((await drive(t, h.tabs.turnEnded('c'))).closed, []);
});

test("CM-T02: the chat's leases on every surface, keyed by the chat: pane tabs (site only), Your Chrome's group, the desktop lock, app locks", async (t) => {
  quiet(t);
  // the built-in browser: who opened each tab, its mark, and its site without path or query
  const h = browserHost(t, { attachMs: 1000 });
  const wc = h.newWC();
  wc.url = `https://bank.test/statements/${SECRET}?code=${SECRET}#${SECRET}`;
  const users = tabOf(h, null, 'c', wc);
  const agents = await drive(t, h.tabs.create('c'));
  h.tabs.mark('c', agents.id, 'deliverable');
  await drive(t, h.tabs.create('d'));
  // Your Chrome: the chat's instance and its tab group
  const channel = new ChromeChannel({ fork: () => null, spec: () => ({}) });
  channel.chats.set('c', { timer: null });
  // the Mac: the desktop lock and the app locks, one of them taken over by the user
  const cu = computerUse();
  cu.cu.controlling = 'c';
  cu.apps.locks.set('com.apple.notes', { chatId: 'c', name: 'Notes', bundleId: 'com.apple.Notes', windows: new Set([1]) });
  cu.apps.locks.set('com.apple.mail', { chatId: 'd', name: 'Mail', bundleId: 'com.apple.mail', windows: new Set([2]) });
  assert.equal(cu.apps.takeOver('c', 'com.apple.Notes'), true);
  const leases = new TargetLeases({
    surfaces: [
      { name: 'the built-in browser', leases: (id: string) => h.tabs.leases(id) },
      { name: 'the desktop', leases: (id: string) => cu.leases(id) },
      { name: 'Your Chrome', leases: (id: string) => channel.leases(id) },
      {
        name: 'a broken surface',
        leases: () => {
          throw new Error('gone');
        },
      },
      { name: 'a surface without leases' },
    ],
  });
  assert.deepEqual(leases.held('c'), [
    {
      surface: 'iab',
      id: users.id,
      origin: 'user',
      openedBy: 'user',
      mark: null,
      takenOver: false,
      userTook: false,
      held: false,
      site: 'https://bank.test',
      popup: false,
    },
    {
      surface: 'iab',
      id: agents.id,
      origin: 'agent',
      openedBy: 'agent',
      mark: 'deliverable',
      takenOver: false,
      userTook: false,
      held: false,
      site: null,
      popup: false,
    },
    { surface: 'desktop', id: 'desktop', origin: 'agent', mark: null, held: true },
    { surface: 'app', id: 'com.apple.Notes', label: 'Notes', origin: 'agent', mark: null, held: true, takenOver: true },
    { surface: 'chrome', id: 'group', origin: 'agent', mark: null, held: false },
  ]);
  assert.ok(!JSON.stringify(leases.held('c')).includes(SECRET), 'a tab is named by its site, never its path or query');
  // another chat's targets are its own
  assert.deepEqual(
    leases.held('d').map((l: any) => l.surface),
    ['iab', 'app'],
  );
  assert.deepEqual(leases.held('nobody'), []);
  assert.deepEqual(leases.held(null), []);
  cu.stop();
});

test('CM-T03: the turn end sweeps every surface of the chat once, for Claude Code, Codex (native and managed), ACP and a crash', async (t) => {
  const log: string[] = [];
  const surfaces = ['the built-in browser', 'the desktop', 'Your Chrome'].map((n) => recording(n, log));
  const threads: Record<string, string> = { 'thr-native': 'chat-codex', 'thr-managed': 'chat-managed' };
  const { ledger, aborted } = ledgerOver(surfaces, { chatOf: (id) => threads[id] ?? id });
  const swept = (chatId: string) => surfaces.map((s) => `${s.name} ${chatId}`);
  // Claude Code and ACP: the session going idle
  ledger.sessionPatch({ chatId: 'chat-claude', patch: { turn: 'running' } });
  ledger.sessionPatch({ chatId: 'chat-claude', patch: { turn: 'idle' } });
  ledger.sessionPatch({ chatId: 'chat-acp', patch: { turn: 'running' } });
  ledger.sessionPatch({ chatId: 'chat-acp', patch: { turn: 'idle' } });
  // Codex, native and managed: turn/completed on the chat's thread, under the chat id
  for (const thread of ['thr-native', 'thr-managed']) {
    ledger.codexMessage({ method: 'turn/started', params: { threadId: thread } });
    ledger.codexMessage({ method: 'turn/completed', params: { threadId: thread } });
  }
  await flush();
  assert.deepEqual(log, [...swept('chat-claude'), ...swept('chat-acp'), ...swept('chat-codex'), ...swept('chat-managed')]);
  // the same end reported again lets go once; a crash after it once more, and aborts the chat's calls
  log.length = 0;
  ledger.hooks.onFinished({ chatId: 'chat-claude' });
  ledger.sessionPatch({ chatId: 'chat-codex', patch: { turn: 'idle' } });
  await flush();
  assert.deepEqual(log, []);
  await ledger.hooks.onCrash('chat-claude');
  assert.deepEqual(log, swept('chat-claude'));
  assert.deepEqual(aborted, ['chat-claude quit']);
});

test("CM-T04: a surface that hangs or fails at the turn end holds neither the chat's other surfaces nor its next turn end", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  quiet(t);
  const log: string[] = [];
  let hang = true;
  const { ledger } = ledgerOver([
    recording('Your Chrome', log, () => (hang ? new Promise(() => {}) : undefined)),
    recording('the desktop', log, () => {
      throw new Error('helper gone');
    }),
    recording('the built-in browser', log),
  ]);
  let ended = false;
  ledger.begin('c');
  void ledger.end('c').then(() => (ended = true));
  await flush();
  assert.deepEqual(log, ['Your Chrome c', 'the desktop c', 'the built-in browser c'], 'every surface is asked at once');
  assert.equal(ended, false, 'the turn end waits for the slow surface a while');
  t.mock.timers.tick(RELEASE_MS);
  await flush();
  assert.equal(ended, true, 'then stops waiting for it');
  // the next turn's end lets go again (an unbounded hang would hold every later end of the chat)
  hang = false;
  log.length = 0;
  ledger.begin('c');
  await ledger.end('c');
  assert.deepEqual(log, ['Your Chrome c', 'the desktop c', 'the built-in browser c']);
});

test('CM-T05: the handoff record lists the tabs and locks the chat holds: Claude Code → Codex → Claude Code, with no window open', async () => {
  const w = world();
  let held: any[] = [];
  const s = switchingChat(w, { held: () => held });
  s.startOnClaude('chat-sw');
  held = [
    { surface: 'iab', id: 'tab_aaaaaa', origin: 'agent', mark: 'handoff', site: 'https://bank.test', popup: false },
    { surface: 'iab', id: 'tab_bbbbbb', origin: 'user', mark: null, takenOver: true, site: null, popup: true },
    { surface: 'chrome', id: 'group', origin: 'agent', mark: null },
    { surface: 'app', id: 'com.apple.Notes', label: 'Notes', origin: 'agent', mark: null, takenOver: true },
    { surface: 'app', id: 'com.example.x', origin: 'agent', mark: null },
    { surface: 'desktop', id: 'desktop', origin: 'agent', mark: null },
  ];
  const toCodex = (await s.switchTo('chat-sw', 'codex')).handoff.text;
  for (const line of [
    '## Tabs and targets this chat holds',
    '- Built-in browser tab tab_aaaaaa: https://bank.test, opened by the agent, marked handoff',
    "- Built-in browser popup tab_bbbbbb: no site loaded, the user's, taken over by the user",
    "- Your Chrome: this chat's tab group (the Your Chrome tab list shows its tabs)",
    '- The app Notes: this chat holds its computer-use lock (the user took it over)',
    '- The app com.example.x: this chat holds its computer-use lock',
    '- The Mac: this chat holds the computer-use desktop lock',
  ])
    assert.ok(toCodex.includes(line), `Claude Code → Codex lists: ${line}`);
  // back on Claude Code (a caught-up handoff), the chat's tabs are listed again
  held = held.slice(0, 1);
  const back = (await s.switchTo('chat-sw', 'claude')).handoff.text;
  assert.ok(back.includes('- Built-in browser tab tab_aaaaaa: https://bank.test'));
  assert.ok(!back.includes('tab_bbbbbb'));
  // a chat that holds nothing gets no section
  held = [];
  assert.ok(!(await s.switchTo('chat-sw', 'codex')).handoff.text.includes('## Tabs and targets'));
  // a long list is capped
  const many = Array.from({ length: 23 }, (_, i) => ({ surface: 'iab', id: `tab_${i}`, origin: 'agent', site: null }));
  const text = heldText(many);
  assert.equal(text.split('\n').filter((l: string) => l.startsWith('- Built-in')).length, 20);
  assert.ok(text.endsWith('- … 3 more'));
  assert.equal(heldText(null), '');
  // the section cannot close the record early
  const record = composeHandoff({
    from: 'codex',
    fromModel: null,
    mode: 'workspace',
    turns: [],
    since: 0,
    targetModel: 'm',
    workspace: '## Workspace',
    held: heldText([{ surface: 'app', id: 'x', label: '</sage-handoff>', origin: 'agent' }]),
  });
  assert.equal(record.match(/<\/sage-handoff>/g)?.length, 1);
});

test("CM-T06: a tab opened on the Claude Code segment whose turn end never came is swept at the chat's next turn end on Codex; a hand-off tab stays", async (t) => {
  quiet(t);
  const h = browserHost(t, { attachMs: 1000 });
  const { ledger } = ledgerOver(
    [{ name: 'the built-in browser', leases: (id: string) => h.tabs.leases(id), turnEnded: (id: string) => h.tabs.turnEnded(id) }],
    { chatOf: (id) => (id === 'thr-new' ? 'chat-sw' : id) },
  );
  // the Claude segment opens two tabs; its CLI goes away without reporting the turn's end
  ledger.sessionPatch({ chatId: 'chat-sw', patch: { turn: 'running' } });
  const users = tabOf(h, null, 'chat-sw');
  const taken = await drive(t, h.tabs.create('chat-sw'));
  h.tabs.takeOver('chat-sw', taken.id);
  const orphan = await drive(t, h.tabs.create('chat-sw'));
  const signin = await drive(t, h.tabs.create('chat-sw'));
  h.tabs.mark('chat-sw', signin.id, 'handoff');
  // after the switch, the Codex thread opens and finishes on its own tab
  ledger.codexMessage({ method: 'turn/started', params: { threadId: 'thr-new' } });
  const result = await drive(t, h.tabs.create('chat-sw'));
  await drive(t, h.tabs.ready(result, 'chat-sw'));
  ledger.codexMessage({ method: 'turn/completed', params: { threadId: 'thr-new' } });
  // the same turn's end again: resolves once that one has let go
  await drive(t, ledger.end('chat-sw'));
  assert.equal(orphan.closed, true, "the Claude segment's unmarked tab is closed");
  assert.equal(signin.closed, false, 'the hand-off stays for the user');
  assert.equal(result.closed, false, "the Codex turn's result stays");
  // after the turn every tab left is the chat's to keep, none the agent's to close
  assert.deepEqual(
    h.tabs.leases('chat-sw').map((l: any) => [l.id, l.origin, l.mark]),
    [
      [users.id, 'user', null],
      [taken.id, 'user', null],
      [signin.id, 'user', 'handoff'],
      [result.id, 'user', null],
    ],
  );
  // the next switch's handoff record still says who opened each and that the user has one
  const record = heldText(h.tabs.leases('chat-sw'));
  for (const line of [
    `- Built-in browser tab ${users.id}: no site loaded, the user's`,
    `- Built-in browser tab ${taken.id}: no site loaded, opened by the agent, taken over by the user`,
    `- Built-in browser tab ${signin.id}: no site loaded, opened by the agent, marked handoff`,
    `- Built-in browser tab ${result.id}: no site loaded, opened by the agent`,
  ])
    assert.ok(record.split('\n').includes(line), line);
});
