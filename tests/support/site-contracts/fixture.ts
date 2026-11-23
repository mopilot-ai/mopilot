// Shared real services and fake browser surfaces for site-permission contract unit cases.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { treeFiles } from '../../../scripts/source-tree.mjs';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';
import { parseSync } from 'vite';
import { tick as flush } from '../async-scenarios.ts';

const require = createRequire(import.meta.url);
const { OriginGrants, BROWSERS } = require('../../../electron/capabilities/browser/origins.cjs');
const {
  IabBackend,
  IabBackends,
  cdpClass,
  cdpPolicy,
  CDP_DOMAINS,
  CDP_METHODS,
  CDP_CLASSES,
  autoAttachParams,
} = require('../../../electron/capabilities/browser/iabBackend.cjs');
const { BrowserTabs } = require('../../../electron/capabilities/browser/host.cjs');
const { BrowserControl } = require('../../../electron/capabilities/browser/control.cjs');
const { chromeTools } = require('../../../electron/capabilities/browser/extension.cjs');
const {
  chromeActionCheck,
  actionsOf,
  dialogMessage,
  parsedIntent,
  ELEMENT_INTENT,
  FOCUS_INTENT,
} = require('../../../electron/capabilities/browser/chromeIntent.cjs');
const { pluginSiteConsent } = require('../../../electron/capabilities/browser/pluginConsent.cjs');
const { CodexBrowserUse, browseBlock, patternCovers } = require('../../../electron/capabilities/browser/codexBrowserUse.cjs');
const { CodexSiteBlocks } = require('../../../electron/capabilities/browser/codexSiteBlocks.cjs');
const { chromeHandoff } = require('../../../electron/capabilities/browser/handoff.cjs');
const { vendorChromeOf, vendorChromeIdOf } = require('../../../shared/controllerPlan.mjs');
const { handoffRoute } = require('../../../shared/chromeHandoff.mjs');
const { createBrowserTools } = require('../../../electron/capabilities/browser/hostTools.cjs');
const { explainRefusal } = require('../../../electron/capabilities/browser/refusals.cjs');
const { ToolError, Registry } = require('../../../electron/capabilities/contract/registry.cjs');
const { guarded } = require('../../../electron/capabilities/contract/actionGuard.cjs');
const { inAppBrowserNote } = require('../../../electron/capabilities/channels/codexConfig.cjs');
const { blockedOf, followUpFor } = await import('../../../src/lib/blockedChoices.ts');
const { controlHandoff, latestHandoff, usesInAppBrowser } = await import('../../../src/lib/agentNarration.ts');
const { skyProblemOfItem, skyStepWorked } = await import('../../../shared/skyComputerUse.mjs');
const { isVendorInstructions } = await import('../../../shared/vendorInstructions.mjs');
const { browserPlace, siteRows, addTarget } = await import('../../../src/lib/browserSites.ts');

const ROOT = new URL('../../../', import.meta.url);
const S = 'thread-1';
const CHAT = 'chat-1';
const ctx = { chatId: CHAT, segmentId: S };

/* ---------- the in-app browser: a fake page under the real iab backend and site grants ---------- */

/** A pane tab as the iab backend sees it (Tab's fields it reads), recording what reaches the page. */
function fakeTab(id: string, url = 'https://shop.test/') {
  const dbg: any = Object.assign(new EventEmitter(), { isAttached: () => true, sendCommand: async () => ({}) });
  const page = { debugger: dbg, isDestroyed: () => false, id: 1 };
  const tab: any = {
    id,
    chatId: CHAT,
    kind: 'tab',
    url,
    title: '',
    closed: false,
    signin: null,
    takenOver: false,
    dialog: null,
    fit: null,
    emulated: null,
    frames: new Map(),
    queue: Promise.resolve(),
    created: true,
    used: 0,
    result: false,
    mark: null,
    markTurn: 0,
    dialogWaiters: new Set(),
    wc: page,
    backend: page,
    sent: [] as any[],
    async attach() {},
    hold() {},
    rendererGone: () => false,
    async send(m: string, p: any = {}, sid = '') {
      tab.sent.push([m, p, sid]);
      return {};
    },
    async agent() {
      return { count: 0 };
    },
  };
  return tab;
}

/** The browser host's surface the backend uses, with the real queue, use order and download listeners. */
function fakeHost() {
  const host: any = Object.create(BrowserTabs.prototype);
  Object.assign(host, {
    o: {},
    chats: new Map(),
    useSeq: 0,
    downloadListeners: new Set(),
    pageListeners: new Set(),
    turnsEnded: new Map(),
    tabs: [] as any[],
    focus: null as any,
    intentAt: null as any,
    emit() {},
    list: () => host.tabs.filter((t: any) => !t.closed),
    current: () => host.tabs[0] ?? null,
    async create() {
      const t = fakeTab(`tab_${host.tabs.length + 1}`);
      host.tabs.push(t);
      host.chats.set(CHAT, { tabs: new Map(host.tabs.map((x: any) => [x.id, x])) });
      return t;
    },
    select() {},
    mark() {},
    async intent(_t: any, target: any) {
      return target?.point ? host.intentAt : host.focus;
    },
  });
  return host;
}

/** The in-app browser's real site table, its cards recorded and answered by `answer`. */
function grantsFor(browser: 'iab' | 'chrome', o: any = {}) {
  const asked: any[] = [];
  const confirmed: any[] = [];
  const g = new OriginGrants({
    browser,
    anchor: () => o.anchor ?? 'ask',
    ask: async (req: any) => (asked.push(req), o.answer ?? { decision: 'allow', scope: 'chat', level: 'write' }),
    confirmAction: async (req: any) => (confirmed.push(req), o.confirm ?? true),
    external: o.external ?? null,
  });
  return { g, asked, confirmed };
}

function iab(o: any = {}) {
  const host = o.host ?? fakeHost();
  const { g, asked, confirmed } = grantsFor('iab', o);
  let on = true;
  const b = new IabBackend({ threadId: S, chatOf: () => CHAT, tabs: () => host, grants: () => g, enabled: () => on });
  const notes: any[] = [];
  b.peers.add({ notify: (m: string, p: any) => notes.push([m, p]) } as any);
  const call = (method: string, params: any = {}) => b.handle(method, { session_id: S, turn_id: 'turn-1', ...params });
  const cdp = (tab: any, method: string, commandParams: any = {}, target: any = {}) =>
    call('executeCdp', { target: { tabId: b.idOf(tab), ...target }, method, commandParams });
  return { b, host, g, asked, confirmed, notes, call, cdp, off: () => (on = false) };
}

async function iabTab(o: any = {}) {
  const k = iab(o);
  await k.call('createTab');
  return { ...k, tab: k.host.tabs[0] };
}

/* ---------- D4: a site table per browser ---------- */

export {
  OriginGrants,
  BROWSERS,
  IabBackend,
  IabBackends,
  cdpClass,
  cdpPolicy,
  CDP_DOMAINS,
  CDP_METHODS,
  CDP_CLASSES,
  autoAttachParams,
  BrowserTabs,
  BrowserControl,
  chromeTools,
  chromeActionCheck,
  actionsOf,
  dialogMessage,
  parsedIntent,
  ELEMENT_INTENT,
  FOCUS_INTENT,
  pluginSiteConsent,
  CodexBrowserUse,
  CodexSiteBlocks,
  browseBlock,
  patternCovers,
  chromeHandoff,
  vendorChromeOf,
  vendorChromeIdOf,
  handoffRoute,
  createBrowserTools,
  explainRefusal,
  ToolError,
  Registry,
  guarded,
  inAppBrowserNote,
  blockedOf,
  followUpFor,
  controlHandoff,
  latestHandoff,
  usesInAppBrowser,
  skyProblemOfItem,
  skyStepWorked,
  isVendorInstructions,
  browserPlace,
  siteRows,
  addTarget,
  ROOT,
  S,
  CHAT,
  ctx,
  flush,
  fakeTab,
  fakeHost,
  grantsFor,
  iab,
  iabTab,
  fs,
  os,
  path,
  treeFiles,
  Window,
  parseSync,
  require,
};
