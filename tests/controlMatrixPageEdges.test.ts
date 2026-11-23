// The control matrix (docs/control-plane/matrix.md): built-in browser pages in edge states, for every harness (Claude
// Code and ACP through browser_*, Codex through browser_* and its Browser plugin's iab backend, a chat that switched
// keeps its chat's tabs). A page's own dialogs reach the agent and the user and the first answer wins; a page that
// asks to confirm leaving is answered, never a silent stay; an untrusted certificate, a link to an app and a page that
// stopped responding each get a notice whose actions can all work; "Continue in Chrome" with no Chrome controller
// ready leads to setting one up. Found by the real-app edge-case suite (docs/control-plane/edge-cases.md, E-P2, E-P5b,
// E-P5c, E-P6, E-S2). BrowserWindows, BrowserTabs, the page dialogs, the hang check, the iab backend, the hand-off
// route and the notice rules are real; Electron's pages, Chrome and the harnesses are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { setup, tabOf, drive, flush } from './support/browser-host-kit.ts';
import { PANE_NOTICE_KINDS, noticeActions } from '../shared/browserNotice.mjs';
import { tick } from './support/async-scenarios.ts';

export const GUARDS = ['electron/', 'shared/'];

const require = createRequire(import.meta.url);
const { browserWorld } = require('./helpers/browser.cjs');
const { BrowserWindows } = require('../electron/capabilities/browser/windows.cjs');
const { PageDialogs } = require('../electron/capabilities/browser/pageDialogs.cjs');
const { PageHang, SUSPECT_MS, PROBE_MS } = require('../electron/capabilities/browser/pageHang.cjs');
const { PanelBrowser } = require('../electron/capabilities/browser/cdp.cjs');
const { IabBackend, IabBackends } = require('../electron/capabilities/browser/iabBackend.cjs');
const { WebPermissions } = require('../electron/capabilities/browser/webPermissions.cjs');
const { chatHandoffRoute, chromeHandoff } = require('../electron/capabilities/browser/handoff.cjs');
const { CHROME_SETUP } = require('../shared/chromeHandoff.mjs');
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');

const ROOT = new URL('../', import.meta.url);

/** BrowserWindows over a fake pane page, with every hook recorded. */
function pane(o: any = {}) {
  const w = browserWorld();
  const notes: string[] = [];
  const cdps: any[] = [];
  const opened: string[] = [];
  const asked: any[] = [];
  const manager = new BrowserWindows({
    ...w,
    acting: () => !!o.acting,
    askLeave: (wc: any) => (asked.push(wc.id), o.leave === undefined ? null : o.leave),
    note: (_wc: any, text: (tabId: string) => string, cdp?: (text: string) => any) => {
      notes.push(text('tab_aaaaaa'));
      if (cdp) cdps.push(cdp(notes.at(-1)!));
    },
    openExternal: async (url: string) => {
      if (o.openFails) throw new Error('no app');
      opened.push(url);
    },
    ...(o.dialogs ? { dialogs: o.dialogs } : {}),
    ...(o.hang ? { hang: o.hang } : {}),
  });
  w.root.isCrashed = () => !!w.root.crashed;
  w.root.forcefullyCrashRenderer = () => {
    w.root.killed = (w.root.killed ?? 0) + 1;
    if (!o.slowKill) w.root.emit('render-process-gone', {}, { reason: 'killed' });
  };
  manager.register(w.root);
  const notice = () => manager.state(w.root.id, w.host)[0];
  return { w, manager, notes, cdps, opened, asked, notice };
}

/** A beforeunload's question as Electron asks it: preventDefault leaves the page. */
function unload(wc: any) {
  const e = { left: false, preventDefault: () => (e.left = true) };
  wc.emit('will-prevent-unload', e);
  return e.left;
}

test('CM-K10: a page that asks to confirm leaving (beforeunload) is answered or shown, never a silent stay', async (t) => {
  // the agent's own action leaves the page, and the agent is told
  const agent = pane({ acting: true, leave: false });
  assert.equal(unload(agent.w.root), true);
  assert.deepEqual(agent.asked, [], "the user is not asked about the agent's own navigation");
  assert.match(agent.notes[0], /^beforeunload tab_aaaaaa: the page asked to confirm leaving it .*it was left, as your action asked/);
  // the user is asked on the window showing the page (Chrome's "Leave site?"): Leave leaves, Cancel stays
  const leaves = pane({ leave: true });
  assert.equal(unload(leaves.w.root), true);
  assert.deepEqual(leaves.asked, [leaves.w.root.id]);
  const stays = pane({ leave: false });
  assert.equal(unload(stays.w.root), false);
  assert.deepEqual(stays.notes, []);
  // no window shows the page, so nobody could answer: it is left, never stuck
  assert.equal(unload(pane().w.root), true);
  // with none of the hooks wired (a test or a window of no chat) a page is left too
  const w = browserWorld();
  new BrowserWindows(w).register(w.root);
  assert.equal(unload(w.root), true);
  // an agent action is under way only inside the tab's queue, on a tab the user hasn't taken over
  const h = setup(t);
  const tab = tabOf(h);
  tab.hold();
  assert.equal(h.tabs.acting(tab.wc), false);
  let inside = false;
  await drive(
    t,
    h.tabs.run(tab, async () => void (inside = h.tabs.acting(tab.wc))),
  );
  assert.equal(inside, true);
  assert.equal(tab.acting, 0);
  await assert.rejects(
    drive(
      t,
      h.tabs.run(tab, async () => {
        throw new Error('the click failed');
      }),
    ),
    /the click failed/,
  );
  assert.equal(tab.acting, 0, 'a failed action is over too');
  tab.acting = 1;
  h.tabs.takeOver('c', 'tab_aaaaaa');
  assert.equal(h.tabs.acting(tab.wc), false, 'the user holds the tab now: the user is asked');
  assert.equal(h.tabs.acting(null), false);
  // the note reaches the agent's next result
  h.tabs.notePage(tab.wc, (id: string) => `beforeunload ${id}: left`);
  h.tabs.notePage(h.newWC(), () => 'a page of no chat');
  h.tabs.notePage(null, () => 'none');
  assert.match(h.tabs.state('c'), /changes: .*beforeunload tab_aaaaaa: left/);
  assert.doesNotMatch(h.tabs.state('c'), /a page of no chat/);
  // the agent's tab no longer turns a beforeunload into a dialog it must answer: Electron answered it already
  await drive(t, tab.attach());
  tab.wc.debugger.event('Page.javascriptDialogOpening', { type: 'beforeunload', message: 'Leave site?' });
  assert.equal(tab.dialog, null);
  tab.wc.debugger.event('Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' });
  assert.equal(tab.dialog?.type, 'confirm', 'a dialog the agent must answer still is one');
});

/** A pane page's dialog request as the preload sends it. */
function ask(dialogs: any, wc: any, type: string, message = '', defaultPrompt = '') {
  const event: any = { sender: wc };
  dialogs.request(event, type, message, defaultPrompt);
  return event;
}

test("CM-M13: a page's prompt() asks the agent (browser_*) or the user, and the first answer is what the page gets", async (t) => {
  const pages = new Set<any>();
  const dialogs = new PageDialogs({ isPage: (wc: any) => pages.has(wc) });
  const h = setup(t, { dialogs });
  const tab = tabOf(h);
  pages.add(tab.wc);
  tab.hold();
  const listened: any[] = [];
  const off = h.tabs.onPageEvent((c: any) => listened.push([c.tab.id, c.open, c.dialog?.type, c.result?.by, c.cdp?.params.errorText]));
  // the agent sees the prompt in every result, with its default and how to answer it
  const waiters: any[] = [];
  tab.dialogWaiters.add((d: any) => waiters.push(d.type));
  const page = ask(dialogs, tab.wc, 'prompt', 'Type the draft name to confirm', 'draft');
  assert.deepEqual(waiters, ['prompt'], 'an input under way stops waiting on the page');
  assert.equal(tab.dialog.type, 'prompt');
  assert.match(
    h.tabs.state('c'),
    /dialog open in tab_aaaaaa: prompt "Type the draft name to confirm" \(default answer "draft"\) — answer it with browser_handle_dialog \(promptText is the answer\)/,
  );
  assert.equal(h.tabs.dialogOpen(tab.wc), true);
  assert.equal(h.tabs.dialogOpen(null), false);
  // the agent answers: the page gets the text
  const out = await drive(t, h.tabs.handleDialog(tab, true, 'Q3 plan'));
  assert.equal(page.returnValue, 'Q3 plan');
  assert.equal(out, 'Accepted the prompt dialog "Type the draft name to confirm" with "Q3 plan".');
  assert.equal(tab.dialog, null);
  // the user answers first in the pane: the agent's late answer says so, and its next result tells it what the user did
  const second = ask(dialogs, tab.wc, 'confirm', 'Delete the draft?');
  assert.equal(dialogs.answer(tab.wc, null, true, null, 'user'), true);
  assert.equal(second.returnValue, true);
  assert.match(h.tabs.state('c'), /changes: the user accepted the confirm dialog on tab_aaaaaa \("Delete the draft\?"\)/);
  ask(dialogs, tab.wc, 'prompt', '');
  const d = tab.dialog;
  dialogs.answer(tab.wc, null, false, null, 'user');
  tab.dialog = d;
  assert.equal(await drive(t, h.tabs.handleDialog(tab, true, null)), 'The prompt dialog "" had already closed.');
  // an approval was about one dialog: its answer never goes to another the page opened meanwhile
  const asked = ask(dialogs, tab.wc, 'confirm', 'Delete the draft?');
  await assert.rejects(drive(t, h.tabs.handleDialog(tab, true, null, tab.dialog.own - 1)), (e: any) => e.code === 'dialog_changed');
  await assert.rejects(drive(t, h.tabs.handleDialog(tab, true, null, null)), (e: any) => e.code === 'dialog_changed');
  assert.equal('returnValue' in asked, false);
  await drive(t, h.tabs.handleDialog(tab, false, null, tab.dialog.own));
  assert.equal(asked.returnValue, false);
  await assert.rejects(drive(t, h.tabs.handleDialog(tab, true, null, null)), /No dialog is open/);
  // dismissed by the agent: null, and no answer text in the result
  const third = ask(dialogs, tab.wc, 'prompt', 'Name?', 'Ada');
  assert.equal(await drive(t, h.tabs.handleDialog(tab, false)), 'Dismissed the prompt dialog "Name?".');
  assert.equal(third.returnValue, null);
  // accepted with no text: the default, as a browser's OK does
  const fourth = ask(dialogs, tab.wc, 'prompt', 'Name?', 'Ada');
  await drive(t, h.tabs.handleDialog(tab, true));
  assert.equal(fourth.returnValue, 'Ada');
  // an alert on a tab the agent drives is accepted with a note, as before; on a tab the user took, it waits for them
  const alert = ask(dialogs, tab.wc, 'alert', 'Deleted "Q3 plan".');
  assert.equal(alert.returnValue, null);
  assert.match(h.tabs.state('c'), /alert dialog on tab_aaaaaa accepted: "Deleted "Q3 plan"\."/);
  ask(dialogs, tab.wc, 'alert', '');
  assert.match(h.tabs.state('c'), /alert dialog on tab_aaaaaa accepted$/m);
  h.tabs.takeOver('c', 'tab_aaaaaa');
  const users = ask(dialogs, tab.wc, 'alert', 'Saved');
  assert.equal('returnValue' in users, false);
  assert.equal(tab.dialog.type, 'alert');
  dialogs.answer(tab.wc, null, true, null, 'gone');
  // a page of no chat's tab: its dialog is the user's alone
  const stranger = h.newWC();
  pages.add(stranger);
  ask(dialogs, stranger, 'confirm', 'x');
  dialogs.answer(stranger, null, true, null);
  assert.deepEqual(
    listened.filter((l) => l[2] === 'prompt').map((l) => l.slice(0, 4)),
    [
      ['tab_aaaaaa', true, 'prompt', undefined],
      ['tab_aaaaaa', false, 'prompt', 'agent'],
      ['tab_aaaaaa', true, 'prompt', undefined],
      ['tab_aaaaaa', false, 'prompt', 'user'],
      ['tab_aaaaaa', true, 'prompt', undefined],
      ['tab_aaaaaa', false, 'prompt', 'agent'],
      ['tab_aaaaaa', true, 'prompt', undefined],
      ['tab_aaaaaa', false, 'prompt', 'agent'],
    ],
  );
  // a blocked link's event reaches the backends too, with the note the agent gets
  h.tabs.notePage(
    tab.wc,
    (id: string) => `app_link ${id}`,
    (text: string) => ({ method: 'Page.navigationBlocked', params: { errorText: text } }),
  );
  h.tabs.notePage(tab.wc, (id: string) => `beforeunload ${id}`);
  assert.deepEqual(listened.at(-1), ['tab_aaaaaa', undefined, undefined, undefined, 'app_link tab_aaaaaa']);
  off();
  assert.equal(h.tabs.pageListeners.size, 0);
});

test('CM-K11: the user sees a page dialog in the pane, never a native sheet left up after the agent answered, and answers it there', () => {
  const dialogs = new PageDialogs({ isPage: () => true });
  const p = pane({ dialogs });
  // the notice carries the dialog for the pane (PageDialogBar), and drops it once answered
  const page = ask(dialogs, p.w.root, 'prompt', 'Type the draft name', 'x');
  assert.deepEqual(p.notice().dialog, { id: 1, type: 'prompt', message: 'Type the draft name', defaultPrompt: 'x', frame: '' });
  assert.equal(p.manager.answerDialog(p.w.root.id, 1, true, 'Q3 plan', p.w.host), true);
  assert.equal(page.returnValue, 'Q3 plan');
  assert.equal(p.notice().dialog, null);
  assert.equal(p.manager.answerDialog(p.w.root.id, 1, true, 'again', p.w.host), false, 'answered already');
  ask(dialogs, p.w.root, 'confirm', 'Sure?');
  assert.equal(p.manager.answerDialog(p.w.root.id, 'not a number', false, undefined, p.w.host), true);
  // a page the pane doesn't know (a dialog of a page that went) changes nothing there
  dialogs.emit('open', { id: -1 }, {});
  // with no dialogs wired, nothing to answer
  const bare = pane();
  assert.equal(bare.manager.answerDialog(bare.w.root.id, 1, true, null, bare.w.host), false);
  // the pages' main frames get the dialogs from MoPilot's preload in every pane session (the shared profile and
  // a chat's own), so Electron's native sheet never shows for them
  // (tests/browserGuestWiring.test.ts)
});

test("CM-K12: Codex's Browser plugin sees a page dialog as CDP's own events and answers it with Page.handleJavaScriptDialog", async () => {
  const tab: any = {
    id: 'tab_aaaaaa',
    dialog: null,
    url: 'https://task.test/',
    takenOver: false,
    frames: new Map(),
    get backend() {
      return this.wc;
    },
    wc: { id: 99, isDestroyed: () => false },
  };
  const answered: any[] = [];
  const host: any = {
    o: {},
    handleDialog: async (t: any, accept: boolean, text: any, expect: any) => {
      answered.push([t.id, accept, text, expect]);
      t.dialog = null;
      return 'Accepted';
    },
    run: (_t: any, fn: any) => fn(),
  };
  const notes: any[] = [];
  const grants = new OriginGrants({
    browser: 'iab',
    anchor: () => 'full',
    ask: async () => ({ decision: 'allow', scope: 'chat', level: 'write' }),
    confirmAction: async () => true,
  });
  const b = new IabBackend({ threadId: 'thread-1', chatOf: () => 'c', tabs: () => host, grants: () => grants });
  b.peers.add({ notify: (m: string, p: any) => notes.push([m, p]) } as any);
  const dialog = { id: 1, type: 'prompt', message: 'Name?', defaultPrompt: 'Ada', url: 'https://task.test/' };
  // only a tab the plugin holds
  b.pageEvent({ tab, open: true, dialog });
  assert.equal(notes.length, 0);
  b.held.set(tab, {});
  const id = b.idOf(tab);
  b.pageEvent({ tab, open: true, dialog });
  assert.deepEqual(notes.at(-1), [
    'onCDPEvent',
    {
      source: { tabId: id },
      method: 'Page.javascriptDialogOpening',
      params: {
        url: 'https://task.test/',
        frameId: `mopilot-iab-tab:${id}`,
        message: 'Name?',
        type: 'prompt',
        hasBrowserHandler: true,
        defaultPrompt: 'Ada',
      },
    },
  ]);
  b.pageEvent({ tab, open: false, dialog, result: { accept: true, value: 'Q3 plan' } });
  assert.deepEqual(notes.at(-1)[1].params, { frameId: `mopilot-iab-tab:${id}`, result: true, userInput: 'Q3 plan' });
  b.pageEvent({ tab, open: false, dialog, result: { accept: false, value: null } });
  assert.deepEqual(notes.at(-1)[1].params, { frameId: `mopilot-iab-tab:${id}`, result: false, userInput: '' });
  b.pageEvent({ tab, open: false, dialog });
  assert.equal(notes.at(-1)[1].params.result, false);
  // a link the page tried to open in an app: a blocked navigation, as the backend's own URL policy reports one
  b.pageEvent({ tab, cdp: { method: 'Page.navigationBlocked', params: { errorText: 'app_link', url: 'zoommtg://x' } } });
  assert.deepEqual(notes.at(-1), [
    'onCDPEvent',
    { source: { tabId: id }, method: 'Page.navigationBlocked', params: { errorText: 'app_link', url: 'zoommtg://x' } },
  ]);
  // the plugin's answer goes where MoPilot holds the dialog (handlers.cjs), not to a CDP dialog that isn't there
  const answer = (commandParams: any) =>
    b.handle('executeCdp', {
      session_id: 'thread-1',
      turn_id: 't1',
      target: { tabId: id },
      method: 'Page.handleJavaScriptDialog',
      commandParams,
    });
  tab.dialog = { type: 'prompt', message: 'Name?', own: 1 };
  assert.deepEqual(await answer({ accept: true, promptText: 'Q3 plan' }), {});
  tab.dialog = { type: 'confirm', message: 'Sure?', own: 2 };
  await answer({ accept: false, promptText: 7 });
  assert.deepEqual(answered, [
    ['tab_aaaaaa', true, 'Q3 plan', 1],
    ['tab_aaaaaa', false, null, 2],
  ]);
  // the manager subscribes each backend while its thread is loaded, and lets go when it goes
  const subs: any[] = [];
  const backends = new IabBackends({
    tabs: () => ({ onPageEvent: (fn: any) => (subs.push(fn), () => subs.splice(subs.indexOf(fn), 1)), onDownload: () => () => {} }),
    grants: () => null,
    chatOf: () => 'c',
    harnessPid: () => 1,
    enabled: () => true,
    pluginEnv: () => ({ backends: ['iab'], flavor: null, version: null }),
    dir: fs.mkdtempSync('/tmp/k12-'),
  });
  await backends.loaded('thread-1');
  const plugin = backends.servers.get('thread-1').backend;
  assert.equal(subs.length, 1);
  plugin.held.set(tab, {});
  subs[0]({ tab, open: true, dialog });
  assert.ok(plugin.ids.size > 0);
  backends.exited();
  assert.deepEqual([subs.length, plugin.offPageEvents], [0, null]);
  // a host without dialogs (an older one) subscribes to nothing
  const none = new IabBackends({
    tabs: () => ({ onDownload: () => () => {} }),
    grants: () => null,
    chatOf: () => 'c',
    harnessPid: () => 1,
    enabled: () => true,
    pluginEnv: () => ({ backends: ['iab'], flavor: null, version: null }),
    dir: fs.mkdtempSync('/tmp/k12b-'),
  });
  await none.loaded('thread-2');
  assert.equal(none.servers.get('thread-2').backend.offPageEvents, null);
  none.exited();
});

test('CM-M14: an untrusted certificate says so and offers only what can work (the user’s own browser), never a Retry; the agent is told why', async (t) => {
  const p = pane();
  p.w.root.emit('did-fail-load', {}, -202, 'ERR_CERT_AUTHORITY_INVALID', 'https://localhost:8791/s/tls', true);
  const n = p.notice();
  assert.deepEqual([n.kind, n.reason], ['failed', 'certificate']);
  assert.match(n.message, /certificate isn't trusted \(ERR_CERT_AUTHORITY_INVALID\)/);
  const actions = noticeActions(n, { loading: false, chat: true, url: 'https://localhost:8791/s/tls' });
  assert.deepEqual(actions, ['openBrowser']);
  assert.equal(actions.includes('retry' as any), false);
  assert.equal(p.manager.dismiss(p.w.root.id, p.w.host), true);
  assert.equal(p.notice().kind, 'ready');
  assert.equal(p.manager.dismiss(p.w.root.id, p.w.host), false, 'nothing to put away');
  const fresh = pane();
  assert.equal(fresh.manager.dismiss(fresh.w.root.id, fresh.w.host), false, 'a page with no notice yet');
  // other failures keep their Retry
  p.w.root.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'u', true);
  assert.deepEqual(noticeActions(p.notice(), {}), ['retry']);
  // the agent's navigation fails with why, for browser_* (every harness) and the legacy panel tools alike
  const h = setup(t);
  const tab = tabOf(h);
  tab.wc.ops.state = () => ({ quietMs: 1000 });
  tab.wc.handlers['Page.navigate'] = () => {
    setTimeout(() => {
      tab.wc.emit('did-fail-load', {}, -202, 'ERR_CERT_AUTHORITY_INVALID', 'u', true);
      tab.wc.emit('did-stop-loading');
    }, 10);
    return { loaderId: 'L1' };
  };
  await assert.rejects(drive(t, h.tabs.navigate(tab, 'https://localhost:8791/s/tls')), (e: any) =>
    /certificate isn't trusted \(ERR_CERT_AUTHORITY_INVALID\)\. The built-in browser never bypasses certificate errors, so retrying won't help/.test(
      e.message,
    ),
  );
  // the legacy panel tools' navigate fails the same way: tests/browserPanel.test.ts 'CDP reports navigation failures…'
});

test('CM-M15: a link to an app (zoommtg:) says so and offers "Open in app", opened only on the user’s click; the agent is told', async () => {
  const p = pane();
  const e = { prevented: false, preventDefault: () => (e.prevented = true) };
  p.w.root.emit('will-navigate', e, 'zoommtg://zoom.us/join?confno=123');
  assert.equal(e.prevented, true);
  assert.deepEqual([p.notice().kind, p.notice().reason], ['blocked', 'app-link']);
  assert.match(p.notice().message, /wants to open an app \(zoommtg:\)/);
  assert.deepEqual(noticeActions(p.notice(), { chat: true, url: 'https://task.test/' }), ['openApp']);
  assert.deepEqual(p.opened, [], 'never opened by itself');
  assert.match(p.notes[0], /^app_link tab_aaaaaa: .*zoommtg: link.*"Open in app"/);
  // the Codex plugin hears it as a blocked navigation (CM-K12), as it does the backend's own URL policy
  assert.deepEqual(p.cdps[0], {
    method: 'Page.navigationBlocked',
    params: { errorText: p.notes[0], url: 'zoommtg://zoom.us/join?confno=123' },
  });
  // the notice outlasts the load that the click started and stopped
  p.w.root.emit('did-stop-loading');
  assert.equal(p.notice().kind, 'blocked');
  // the click opens the link its notice offered, never one the page (or a frame) set since
  const offered = p.notice().link;
  assert.equal(typeof offered, 'number');
  p.manager.external(p.w.root, 'smb://evil.test/share');
  assert.equal(p.notice().reason, 'address', 'a network share is never offered');
  await assert.rejects(p.manager.openAppLink(p.w.root.id, offered, p.w.host), /another app link now, or none/);
  p.w.root.emit('will-navigate', { preventDefault() {} }, 'zoommtg://zoom.us/join?confno=123');
  const now = p.notice().link;
  p.manager.external(p.w.root, 'facetime://x');
  await assert.rejects(p.manager.openAppLink(p.w.root.id, now, p.w.host), /another app link now/);
  p.w.root.emit('will-navigate', { preventDefault() {} }, 'zoommtg://zoom.us/join?confno=123');
  assert.equal(await p.manager.openAppLink(p.w.root.id, p.notice().link, p.w.host), true);
  assert.deepEqual(p.opened, ['zoommtg://zoom.us/join?confno=123']);
  assert.deepEqual([p.notice().kind, p.notice().link], ['ready', null]);
  await assert.rejects(p.manager.openAppLink(p.w.root.id, now, p.w.host), /or none/);
  // a new document takes its app link with it
  p.w.root.emit('will-navigate', { preventDefault() {} }, 'zoommtg://x');
  const stale = p.notice().link;
  p.w.root.emit('did-navigate');
  await assert.rejects(p.manager.openAppLink(p.w.root.id, stale, p.w.host), /or none/);
  // a popup to an app link, and a frame's (Electron asks the openExternal permission for those): the same notice
  assert.deepEqual(p.w.root.windowOpen({ url: 'slack://open' }), { action: 'deny' });
  assert.match(p.notice().message, /an app \(slack:\)/);
  const perms = new WebPermissions({
    driver: () => null,
    ask: async () => null,
    note() {},
    external: (wc: any, url: string) => p.manager.external(wc, url),
  });
  assert.equal(await perms.request(p.w.root, 'openExternal', { externalURL: 'mailto:a@b.c' }), false);
  assert.equal(await perms.request(p.w.root, 'openExternal', undefined), false, 'a request that names no link');
  assert.match(p.notice().message, /an app \(mailto:\)/);
  assert.equal(
    await new WebPermissions({ driver: () => null, ask: async () => null, note() {} }).request(p.w.root, 'openExternal', {}),
    false,
  );
  p.manager.external(null, 'tel:1');
  p.manager.external(p.w.root, '');
  // a local file or script is never opened: Dismiss only
  p.w.root.emit('will-redirect', { preventDefault() {} }, 'file:///etc/passwd');
  assert.deepEqual(noticeActions(p.notice(), { chat: true }), []);
  await assert.rejects(p.manager.openAppLink(p.w.root.id, 1, p.w.host), /or none/);
  assert.equal(p.manager.dismiss(p.w.root.id, p.w.host), true);
  // with no opener wired, opening fails with why
  const bare = browserWorld();
  const m = new BrowserWindows(bare);
  m.register(bare.root);
  bare.root.emit('will-navigate', { preventDefault() {} }, 'zoommtg://x');
  await assert.rejects(m.openAppLink(bare.root.id, m.state(bare.root.id, bare.host)[0].link, bare.host), /not available here/);
  const failing = pane({ openFails: true });
  failing.w.root.emit('will-navigate', { preventDefault() {} }, 'zoommtg://x');
  await assert.rejects(failing.manager.openAppLink(failing.w.root.id, failing.notice().link, failing.w.host), /no app/);
});

test('CM-M16: a page that stopped responding fails browser calls at once with why, and every result says so until it responds', async (t) => {
  let release: () => void = () => {};
  const hang = new PageHang({ probe: () => new Promise<void>((r) => (release = r)) });
  const h = setup(t, { hang });
  const tab = tabOf(h);
  await drive(t, tab.attach());
  // a command the busy page never answers: the page is checked, found hung, and the call fails with why, in seconds
  tab.wc.handlers['Runtime.evaluate'] = () => new Promise(() => {});
  const call = tab.send('Runtime.evaluate', { expression: '1' });
  let failed: any = null;
  call.catch((e: any) => (failed = e));
  await tick();
  t.mock.timers.tick(SUSPECT_MS);
  await tick();
  t.mock.timers.tick(PROBE_MS);
  await tick();
  assert.equal(failed?.code, 'page_unresponsive');
  assert.match(failed.message, /^tab_aaaaaa isn't responding: a script on the page is busy.*Don't retry it now/);
  // every later call fails at once, and every result says why
  await assert.rejects(tab.send('Page.captureScreenshot'), (e: any) => e.code === 'page_unresponsive');
  assert.match(h.tabs.state('c'), /not responding: tab_aaaaaa isn't responding/);
  // the page answers its check at last: calls go through again and the agent is told
  release();
  await tick();
  assert.equal(hang.hung(tab.wc), false);
  assert.match(h.tabs.state('c'), /changes: page_responsive tab_aaaaaa responds again/);
  assert.doesNotMatch(h.tabs.state('c'), /not responding/);
  hang.emit('change', h.newWC(), true);
  // the legacy panel tools (sage_browser_*) fail at once on a hung page too
  const w = browserWorld();
  w.root.debugger.attach();
  const panel = new PanelBrowser({ ...w, open: () => false, hang });
  hang.state.set(w.root.id, 'hung');
  await assert.rejects(
    panel.send('c', 'Runtime.evaluate', {}, { backend: w.root }),
    (e: any) => e.code === 'page_unresponsive' && /isn't responding/.test(e.message),
  );
  hang.state.delete(w.root.id);
  assert.ok(await panel.send('c', 'Runtime.evaluate', {}, { backend: w.root }));
});

test('CM-K13: the pane says a page stopped responding, offers Wait, Reload and Close tab, and Reload stops the renderer first', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hang = new PageHang({ probe: () => new Promise(() => {}) });
  const p = pane({ hang });
  hang.emit('change', p.w.root, true);
  assert.deepEqual([p.notice().kind, p.notice().message.slice(0, 25)], ['unresponsive', "This page isn't respondin"]);
  assert.deepEqual(noticeActions(p.notice(), { chat: true, url: 'https://task.test/' }), ['wait', 'restart', 'closeTab']);
  p.w.root.emit('did-stop-loading');
  assert.equal(p.notice().kind, 'unresponsive', 'it stays up until the page responds');
  hang.state.set(p.w.root.id, 'hung');
  p.w.root.emit('did-start-loading');
  assert.equal(p.notice().kind, 'unresponsive', 'a load the hung page starts keeps its actions up');
  hang.state.delete(p.w.root.id);
  hang.emit('change', p.w.root, false);
  assert.equal(p.notice().kind, 'ready');
  hang.emit('change', p.w.root, false);
  hang.emit('change', { id: -5 }, true);
  // Reload and Close tab stop the renderer first: a reload of a busy page never starts otherwise
  hang.emit('change', p.w.root, true);
  assert.equal(await p.manager.stop(p.w.root.id, p.w.host), true);
  assert.equal(p.w.root.killed, 1);
  assert.equal(p.notice().kind, 'crashed');
  p.w.root.crashed = true;
  assert.equal(await p.manager.stop(p.w.root.id, p.w.host), false, 'gone already');
  // a renderer that doesn't report going is waited for only so long
  const slow = pane({ hang, slowKill: true });
  const stopping = slow.manager.stop(slow.w.root.id, slow.w.host);
  await tick();
  t.mock.timers.tick(3_000);
  assert.equal(await stopping, true);
  assert.equal(slow.w.root.killed, 1);
  // the pane's handlers are a Record<NoticeAction, …> (BrowserPanel), so tsc refuses a missing one, and that type names
  // every action NOTICE_ACTIONS has, so no button is ever offered with nothing behind it: tests/pageNoticeBar.test.ts
});

test('CM-K14: guard: every page notice main shows offers only actions that can work for it, from one rule', () => {
  // the kinds main emits (windows.cjs) and the reasons that narrow them (shared/browserNotice.mjs)
  const windows = fs.readFileSync(new URL('electron/capabilities/browser/windows.cjs', ROOT), 'utf8');
  const kinds = new Set([...windows.matchAll(/this\.event\(\s*page,\s*'([a-z]+)'/g)].map((m) => m[1]));
  const cases = [
    { kind: 'failed', reason: 'load' },
    { kind: 'failed', reason: 'certificate' },
    { kind: 'failed', reason: 'input' },
    { kind: 'slow' },
    { kind: 'crashed' },
    { kind: 'blocked', reason: 'app-link' },
    { kind: 'blocked', reason: 'address' },
    { kind: 'unresponsive' },
  ];
  // what each action needs to work (the dead-end rule, E-X1)
  const works: Record<string, (n: any, ctx: any) => boolean> = {
    retry: (n) => !['certificate', 'input', 'app-link', 'address', 'unresponsive', 'crashed'].includes(n.reason ?? n.kind),
    reload: (n) => n.kind === 'crashed',
    stop: (_n, c) => c.loading,
    chrome: (n, c) => c.chat && n.kind !== 'unresponsive' && n.reason !== 'certificate',
    openBrowser: (n, c) => n.reason === 'certificate' && /^https?:/.test(c.url),
    openApp: (n) => n.reason === 'app-link',
    dismiss: (n) => ['failed', 'blocked'].includes(n.kind),
    wait: (n) => n.kind === 'unresponsive',
    restart: (n) => n.kind === 'unresponsive',
    closeTab: (n, c) => n.kind === 'unresponsive' && !c.popup,
    // a popup window closes as a window, not as the tab
    closeWindow: (n, c) => n.kind === 'unresponsive' && c.popup,
  };
  // every kind the pane shows as a notice (rendered: browser-panel-ui/page-edges.ts) is one main emits, with cases here
  assert.deepEqual(PANE_NOTICE_KINDS, ['failed', 'crashed', 'slow', 'blocked', 'unresponsive']);
  for (const k of PANE_NOTICE_KINDS) {
    assert.ok(kinds.has(k), `main emits ${k}`);
    assert.ok(
      cases.some((c) => c.kind === k),
      `${k} has cases`,
    );
  }
  for (const n of cases)
    for (const ctx of [
      { loading: false, chat: false, url: '' },
      { loading: true, chat: true, url: 'https://task.test/' },
      { loading: false, chat: true, url: 'https://idp.test/', popup: true },
    ]) {
      const actions = noticeActions(n, ctx);
      // every notice also closes (PaneNotice): tests/browserNoticeClose.test.ts
      for (const a of actions) assert.ok(works[a](n, ctx), `${n.kind}/${n.reason}: ${a} can't work there`);
    }
  // the pane renders a notice's buttons only from that rule (PageNoticeBar), never a hand-written Retry:
  // tests/pageNoticeBar.test.ts and tests/support/browser-panel-ui/page-edges.ts render them
});

test('CM-M12: "Continue in Chrome" with Your Chrome but no Playwright Extension leads to setting it up, never an "Open in Chrome" that fails', async () => {
  const isEnabled = (key: string) => key === 'shared.browser.extension';
  const base = { plan: null, relay: null, isEnabled, channel: 'builtin', channelEnabled: true, tools: ['sage_browser_snapshot'] };
  assert.equal(chatHandoffRoute({ ...base, extension: () => false }), 'setup');
  assert.equal(chatHandoffRoute({ ...base, channel: 'chrome', extension: () => false }), 'setup');
  assert.equal(chatHandoffRoute({ ...base, extension: () => true }), 'your-chrome');
  assert.equal(chatHandoffRoute(base), 'your-chrome', 'unknown counts as there');
  // a route that doesn't need the extension never reads it
  let read = 0;
  assert.equal(chatHandoffRoute({ ...base, isEnabled: () => false, extension: () => (read++, false) }), 'none');
  assert.equal(read, 0);
  // a hand-off started anyway says what to set up, and opens nothing
  const w = browserWorld();
  const windows = new BrowserWindows(w);
  windows.register(w.root);
  let started = 0;
  const out = await chromeHandoff({
    browserWindows: windows,
    chromeChannel: {
      has: () => false,
      instance: async () => (started++, {}),
    },
    browserControl: {},
    isEnabled: () => true,
    getPrefs: () => ({ channel: 'builtin' }),
    commitPrefs() {},
    changed() {},
    route: () => 'setup',
  })({ webContentsId: w.root.id, chatId: 'c', url: 'https://task.test/' }, w.host);
  assert.deepEqual(out, { ok: false, message: CHROME_SETUP });
  assert.equal(started, 0);
  // main reads whether the extension is there (tests/browserPageEdgesWiring.test.ts); the pane shows each route's setup
  // (tests/support/browser-panel-ui/page-edges.ts and profiles-chrome.ts render 'setup', 'setup-extension' and 'none')
});

test('CM-K15: a page waiting on its own dialog is not a hung page, whichever harness drives it', async (t) => {
  const dialogs = new PageDialogs({ isPage: () => true });
  const hang = new PageHang({
    blocked: (wc: any) => !!dialogs.of(wc) || !!h.tabs.dialogOpen(wc),
    probe: () => new Promise(() => {}),
  });
  const h = setup(t, { dialogs, hang });
  const tab = tabOf(h);
  await drive(t, tab.attach());
  tab.hold();
  h.tabs.takeOver('c', 'tab_aaaaaa');
  // the page is blocked in its prompt, so its script can't answer a check: that's the dialog, not a hang
  ask(dialogs, tab.wc, 'prompt', 'Name?');
  hang.watch(tab.wc);
  tab.wc.emit('unresponsive');
  hang.suspect(tab.wc);
  t.mock.timers.tick(PROBE_MS);
  assert.equal(hang.hung(tab.wc), false);
  // a frame's own dialog over CDP counts the same
  dialogs.answer(tab.wc, null, false, null);
  tab.dialog = { type: 'confirm', message: '' };
  hang.suspect(tab.wc);
  t.mock.timers.tick(PROBE_MS);
  assert.equal(hang.hung(tab.wc), false);
  tab.dialog = null;
  hang.suspect(tab.wc);
  t.mock.timers.tick(PROBE_MS);
  assert.equal(hang.hung(tab.wc), true);
  await flush();
});

test("CM-K16: an embedded page's (a frame's) alert, confirm and prompt reach the pane and the agent like the page's own, saying which page asks", async (t) => {
  // every frame of a pane page runs the dialog preload: views, native popups and <webview> guests, all sandboxed
  const { HARDENED } = require('../electron/capabilities/browser/views.cjs');
  assert.deepEqual([HARDENED.nodeIntegrationInSubFrames, HARDENED.sandbox, HARDENED.nodeIntegration], [true, true, false]);
  const w = browserWorld();
  new BrowserWindows(w).register(w.root);
  const popupPrefs = w.root.windowOpen({ url: 'https://idp.test/' }).overrideBrowserWindowOptions.webPreferences;
  assert.deepEqual([popupPrefs.nodeIntegrationInSubFrames, popupPrefs.sandbox], [true, true]);
  // a legacy <webview> guest gets the same: tests/browserGuestWiring.test.ts
  // the agent sees it with the embedded page named, and answers it as any other
  const dialogs = new PageDialogs({ isPage: () => true });
  const h = setup(t, { dialogs });
  const tab = tabOf(h);
  tab.wc.mainFrame = { url: 'https://shop.test/' };
  const asked: any = { sender: tab.wc, senderFrame: { url: 'https://pay.example/checkout' } };
  dialogs.request(asked, 'prompt', 'Card code?', '');
  assert.match(h.tabs.state('c'), /dialog open in tab_aaaaaa \(from an embedded page at https:\/\/pay\.example\): prompt "Card code\?"/);
  await drive(t, h.tabs.handleDialog(tab, true, '123'));
  assert.equal(asked.returnValue, '123');
  // the pane names it too (PageDialogBar)
  const p = pane({ dialogs });
  dialogs.request({ sender: p.w.root, senderFrame: { url: 'https://pay.example/x' } }, 'confirm', 'Pay?', '');
  assert.equal(p.notice().dialog.frame, 'https://pay.example');
});

test('CM-K17: a popup window that stopped responding offers Wait, Reload and Close window, each stopping the busy renderer first', async () => {
  assert.deepEqual(noticeActions({ kind: 'unresponsive' }, { popup: true }), ['wait', 'restart', 'closeWindow']);
  const p = pane();
  p.w.root.reload = () => (p.w.root.reloads = (p.w.root.reloads ?? 0) + 1);
  assert.equal(await p.manager.stop(p.w.root.id, p.w.host), true);
  assert.equal(p.manager.reload(p.w.root.id, p.w.host), true);
  assert.equal(p.w.root.reloads, 1);
  // the pane renders a hung popup's notice through the same rule, with the popup's own handlers: rendered in
  // tests/support/browser-panel-ui/page-edges.ts ("a popup window that stopped responding…")
});
