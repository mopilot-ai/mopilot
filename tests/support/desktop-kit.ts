// Fakes for the desktop_* tool tests (electron/capabilities/tools/desktop.cjs and its layer modules): a scripted helper
// (the JSON-RPC client mocked at its method boundary), a scripted computer-use coordinator, the approval broker and the
// grant store, wired into a DesktopControl; plus the apps, display and accessibility snapshot the tests use.
import { createRequire } from 'node:module';
import { MAIL, NOTES, SAFARI, TERMINAL, computerUse, recordingBroker, toolCalls } from './computer-tool-kit.ts';
export { MAIL, NOTES, SAFARI, TERMINAL, ToolError, rejects } from './computer-tool-kit.ts';

const require = createRequire(import.meta.url);
const { ComputerHold } = require('../../electron/capabilities/tools/computerHold.cjs');
const { DesktopTakeover } = require('../../electron/capabilities/tools/takeoverWait.cjs');
export const D = require('../../electron/capabilities/tools/desktop.cjs');
export { desktopToolSpecs } from './tool-specs.ts';
export const { DesktopControl, SPECS, ACTION_SPECS, ACTIONS, TOOL_NAMES, indexElements, processAncestry, onboarding } = D;
export const P = require('../../electron/capabilities/contract/desktopPolicy.cjs');
export const { GrantStore } = require('../../electron/capabilities/grants.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

export const FINDER = { pid: 11, bundleId: 'com.apple.finder', name: 'Finder' };
export const MOPILOT = { pid: 1, bundleId: 'ai.mopilot.code', name: 'MoPilot', refused: 'MoPilot' };

/** A display of 2000x1000 points shot at 1000x500 pixels: one pixel is two points. */
export const DISPLAY = { id: 1, x: 0, y: 0, width: 2000, height: 1000 };

/** Elements of the frontmost app, in global points. */
export function snapshot() {
  return {
    root: {
      id: '0',
      role: 'AXApplication',
      title: 'App',
      children: [
        { id: '0.0', role: 'AXButton', title: 'Send', frame: { x: 200, y: 100, w: 40, h: 20 } },
        { id: '0.1', role: 'AXTextField', title: '', value: 'To:  someone', frame: { x: 400, y: 200, w: 200, h: 40 } },
        { id: '0.2', role: 'AXStaticText', frame: { x: 10, y: 10, w: 10, h: 10 } },
        { id: '0.3', role: 'AXImage', frame: { x: 30, y: 30, w: 10, h: 10 } },
        {
          id: '0.4',
          role: 'AXGroup',
          frame: { x: 0, y: 0, w: 2000, h: 1000 },
          children: [
            { id: '0.4.0', role: 'AXCheckBox', description: 'Bold', enabled: false, frame: { x: 600, y: 600, w: 20, h: 20 } },
            null,
            { id: '0.4.1', role: 'AXButton', title: 'Gone', frame: { x: 600, y: 600, w: 0, h: 20 } },
            { id: '0.4.2', role: 'AXButton', title: 'Elsewhere', frame: { x: 5000, y: 600, w: 20, h: 20 } },
            { id: '0.4.3', role: 'AXImage', title: 'Logo', frame: { x: 800, y: 100, w: 20, h: 20 } },
            { id: '0.4.4', role: 'AXLink', title: 'x'.repeat(100), frame: { x: 900, y: 100, w: 20, h: 20 } },
            { id: '0.4.5', role: 7, frame: { x: 900, y: 100, w: 20, h: 20 } },
            { id: '0.4.6', role: 'AXButton', frame: { x: 950, y: 300, w: 20, h: 20 } },
          ],
        },
      ],
    },
  };
}

export function fakeHelper() {
  const calls: { method: string; args: any[] }[] = [];
  const h: any = {
    calls,
    running: true,
    fail: {} as Record<string, any>,
    front: NOTES as any,
    at: null as any,
    resolved: new Map<string, any>(),
    perms: { screenRecording: true, accessibility: true } as any,
    apps: [] as any[],
    displays: [DISPLAY, { id: 2, x: 2000, y: 0, width: 1000, height: 800, scale: 2, main: false, name: 'Side' }],
    openFront: true,
    snap: snapshot() as any,
    press: { ok: true },
    focus: { ok: true },
    typed: null as number | null,
    /** what text.focused reads (null: nothing readable) */
    field: null as any,
    insert: { ok: false, reason: 'not_settable' } as any,
    hidden: [] as any[],
    shot: (o: any) => ({
      jpeg: 'JPEG',
      width: 1000,
      height: 500,
      pixelsPerPoint: 0.5,
      display: DISPLAY,
      included: o.includeBundleIds ?? o.bundleIds,
      mimeType: 'image/jpeg',
    }),
  };
  const rec =
    (method: string, out: any) =>
    async (...args: any[]) => {
      calls.push({ method, args });
      const f = h.fail[method];
      if (f) throw typeof f === 'function' ? f(...args) : f;
      return typeof out === 'function' ? out(...args) : out;
    };
  Object.assign(h, {
    start: rec('start', {}),
    stop: () => calls.push({ method: 'stop', args: [] }),
    resolveApps: rec('resolveApps', (qs: string[]) => ({ apps: qs.map((q) => h.resolved.get(q) ?? { query: q, app: null }) })),
    permissionStatus: rec('permissionStatus', () => h.perms),
    listApps: rec('listApps', () => ({ apps: h.apps })),
    openApp: rec('openApp', () => ({ frontmost: h.openFront })),
    listDisplays: rec('listDisplays', () => ({ displays: h.displays })),
    targetInfo: rec('targetInfo', (p: any) => (p ? (typeof h.at === 'function' ? h.at(p) : (h.at ?? h.front)) : h.front)),
    screenshot: rec('screenshot', (o: any) => h.shot(o)),
    axSnapshot: rec('axSnapshot', () => h.snap),
    cursor: rec('cursor', { x: 200, y: 100 }),
    acquireControl: rec('acquireControl', {}),
    click: rec('click', { ok: true }),
    move: rec('move', { ok: true }),
    drag: rec('drag', { ok: true }),
    scroll: rec('scroll', { ok: true }),
    type: rec('type', (chunk: string) => (h.typed == null ? { ok: true } : { ok: true, typed: h.typed })),
    key: rec('key', { ok: true }),
    call: rec('call', { ok: true }),
    releaseInput: rec('releaseInput', { ok: true }),
    resumeControl: rec('resumeControl', {}),
    axPress: rec('axPress', () => h.press),
    axFocus: rec('axFocus', () => h.focus),
    button: rec('button', { ok: true }),
    focusedText: rec('focusedText', () => (typeof h.field === 'function' ? h.field() : h.field)),
    insertText: rec('insertText', () => h.insert),
    paste: rec('paste', { ok: true }),
    hideOthers: rec('hideOthers', () => ({ hidden: h.hidden })),
    restoreApps: rec('restoreApps', { ok: true }),
    saveClipboard: rec('saveClipboard', { saved: true }),
    restoreClipboard: rec('restoreClipboard', { restored: true }),
  });
  return h;
}

export const resolveEntry = (app: any, extra: any = {}) => ({ query: app.name, app: { ...app, running: true }, ...extra });

export function rig(
  o: {
    indicator?: boolean;
    clipboard?: boolean;
    hostPids?: any;
    settleMs?: number;
    saved?: any[];
    deny?: string[];
    modelOf?: any;
    hide?: boolean;
    host?: any;
    grants?: any;
    takeoverWaitMs?: number;
  } = {},
) {
  const helper = fakeHelper();
  const answers: Record<string, any> = {
    computerAccessSet: { decision: 'allow' },
    computerTakeover: { decision: 'allow' },
    computerConfirm: { decision: 'allow' },
  };
  const { broker, asks } = recordingBroker(answers);
  const state: any = { unattended: null, unattendedAllowed: true, session: { permission: 'default' } };
  const released: string[] = [];
  const { cu, activity, paused } = computerUse(state, (cu) => ({
    holder: (chatId: string) => `chat ${chatId}`,
    release: async (chatId: string) => {
      released.push(chatId);
      if (cu.controlling === chatId) cu.controlling = null;
    },
    // the user's take-over and "Done, continue", as ComputerUse runs them
    helper,
    takeover: new DesktopTakeover({ ms: o.takeoverWaitMs ?? 10_000 }),
    paused: ComputerHold.prototype.paused,
    resume: ComputerHold.prototype.resume,
    resumeAfterCard: ComputerHold.prototype.resumeAfterCard,
    cutShort: ComputerHold.prototype.cutShort,
    stop: async (chatId: string) => cu.takeover.end(chatId, new Error('stopped')),
  }));
  const saved = o.saved ?? [];
  const deny = o.deny ?? [];
  const grants = o.grants ?? { forChat: () => saved, deny: () => deny };
  const escapes: string[] = [];
  const indicator = { suspendEscape: async (fn: () => Promise<any>) => (escapes.push('suspend'), fn()) };
  let clip = 'copied';
  const clipboard = {
    readText: () => clip,
    writeText: (t: string) => {
      clip = t;
    },
  };
  const ended: string[] = [];
  const d = new DesktopControl({
    helper,
    cu,
    grants,
    broker,
    clipboard: o.clipboard === false ? null : clipboard,
    indicator: o.indicator === false ? null : indicator,
    hostPids: o.hostPids ?? (async () => new Set([1, 2])),
    helperInfo: { name: 'Helper', bundleId: 'ai.helper', path: '/Apps/Helper.app' },
    onTurnEnded: (c: string) => ended.push(c),
    settleMs: o.settleMs ?? 0,
    verifyMs: 0,
    modelOf: o.modelOf,
    hideBeforeAction: o.hide ? () => true : undefined,
    host: o.host,
  });
  const { call, text, callsOf } = toolCalls((tool, args, ctx) => d.run(tool, args, ctx), helper);
  const json = async (tool: string, args: any = {}, ctx?: any) => JSON.parse(await text(tool, args, ctx));
  const methods = () => helper.calls.map((c: any) => c.method);
  /** grants these apps in c1 through desktop_request_access */
  const grant = async (apps: any[] = [NOTES], chatId = 'c1') => {
    for (const a of apps) helper.resolved.set(a.name, resolveEntry(a));
    return JSON.parse((await call('desktop_request_access', { apps: apps.map((a) => a.name), reason: 'test' }, { chatId }))[0].text);
  };
  /** grants, takes a screenshot (the coordinate frame), and clears the call log */
  const ready = async (apps: any[] = [NOTES]) => {
    await grant(apps);
    await call('desktop_screenshot');
    helper.calls.length = 0;
    asks.length = 0;
  };
  return {
    d,
    helper,
    cu,
    broker,
    asks,
    answers,
    state,
    activity,
    paused,
    released,
    ended,
    escapes,
    saved,
    deny,
    call,
    text,
    json,
    methods,
    callsOf,
    grant,
    ready,
    clip: () => clip,
    setClip: (t: string) => {
      clip = t;
    },
  };
}

export function callsOf(r: any, m: string) {
  return r.helper.calls.filter((c: any) => c.method === m);
}

/** A real grant store on a temporary file, and a chat store keeping each chat's meta. */
export function grantStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-always-'));
  const meta = new Map<string, any>();
  const chats = {
    get: (id: string) => (meta.has(id) ? { meta: meta.get(id) } : null),
    patchMeta: (id: string, p: any) => (meta.set(id, { ...(meta.get(id) ?? {}), ...p }), true),
  };
  const store = new GrantStore({ file: path.join(dir, 'computer.json'), chats });
  return { store, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export const BY_ID: Record<string, any> = Object.fromEntries([NOTES, MAIL, TERMINAL, SAFARI, FINDER].map((a) => [a.bundleId, a]));
/** activation really brings the app forward in the fake */
export function activates(r: any) {
  r.helper.openApp = async (...args: any[]) => {
    r.helper.calls.push({ method: 'openApp', args });
    r.helper.front = BY_ID[args[0]];
    return { frontmost: true };
  };
}

/** A text field the fake helper reads and writes: typed keys and inserts land at the caret. */
export function field(r: any, init = '') {
  const f = { value: init, sel: { location: init.length, length: 0 }, readable: true };
  r.helper.field = () => (f.readable ? { value: f.value, selection: f.sel } : null);
  const put = (t: string) => {
    f.value = f.value.slice(0, f.sel.location) + t + f.value.slice(f.sel.location + f.sel.length);
    f.sel = { location: f.sel.location + t.length, length: 0 };
  };
  r.helper.type = async (chunk: string, o: any) => {
    r.helper.calls.push({ method: 'type', args: [chunk, o] });
    put(chunk);
    return { ok: true };
  };
  return { f, put };
}
