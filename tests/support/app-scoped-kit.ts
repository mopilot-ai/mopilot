// Fakes for the background desktop_app_* tool tests (electron/capabilities/tools/appScoped.cjs and its layer modules): a
// scripted helper (the JSON-RPC client mocked at its call boundary), the real DesktopControl for grants, tiers and the
// permission card, a scripted computer-use coordinator and the approval broker, plus the window and tree the tests use.
import { createRequire } from 'node:module';
import { MAIL, NOTES, SAFARI, TERMINAL, computerUse, recordingBroker, toolCalls } from './computer-tool-kit.ts';
export { tick } from './async-scenarios.ts';
export { MAIL, NOTES, SAFARI, TERMINAL, ToolError, rejects } from './computer-tool-kit.ts';

const require = createRequire(import.meta.url);
export { appToolSpecs } from './tool-specs.ts';
export const A = require('../../electron/capabilities/tools/appScoped.cjs');

export const {
  AppScopedControl,
  SPECS,
  TOOL_NAMES,
  indexWindowElements,
  elementAt,
  normalizeAppKey,
  keyVerdict,
  appHelperError,
  observedEffect,
  withHint,
  NO_CHANGE_HINT,
  TAKEOVER_WAIT_MS,
} = A;
export const { DesktopControl } = require('../../electron/capabilities/tools/desktop.cjs');
export const { placement } = require('../../electron/capabilities/contract/hostServers.cjs');

/** A 500x400-point window at (100, 50), captured at 2 pixels per point: a 1000x800 frame. */
export const WIN = { window_id: 5, title: 'Doc', state: 'visible', is_main: true, bounds: { x: 100, y: 50, width: 500, height: 400 } };

export function tree() {
  return {
    nodes: 12,
    truncated: false,
    root: {
      id: '0',
      role: 'AXWindow',
      title: 'Doc',
      children: [
        { id: '0.0', role: 'AXButton', title: 'Send', frame: { x: 110, y: 60, w: 40, h: 20 }, actions: ['AXPress'] },
        { id: '0.1', role: 'AXTextArea', value: 'draft', frame: { x: 100, y: 100, w: 400, h: 200 }, settable: true, focused: true },
        { id: '0.2', role: 'AXPopUpButton', title: 'Font', frame: { x: 300, y: 60, w: 60, h: 20 }, actions: ['AXPress', 'AXShowMenu'] },
        { id: '0.3', role: 'AXTextField', secure: true, frame: { x: 400, y: 320, w: 80, h: 20 } },
        { id: '0.4', role: 'AXStaticText', frame: { x: 10, y: 10, w: 10, h: 10 } },
        {
          id: '0.5',
          role: 'AXScrollArea',
          frame: { x: 100, y: 50, w: 450, h: 400 },
          children: [
            { id: '0.5.0', role: 'AXButton', title: 'Far', frame: { x: 2000, y: 60, w: 20, h: 20 } },
            null,
            { id: '0.5.1', role: 'AXCheckBox', description: 'Bold', enabled: false, frame: { x: 500, y: 60, w: 20, h: 20 } },
            { id: '0.5.2', role: 7, frame: { x: 500, y: 60, w: 20, h: 20 } },
            { id: '0.5.3', role: 'AXButton', title: 'Plain', frame: { x: 200, y: 330, w: 40, h: 20 } },
            { id: '0.5.4', role: 'AXButton', title: 'Zero', frame: { x: 200, y: 330, w: 0, h: 20 } },
            { id: '0.5.5', role: 'AXImage', frame: { x: 250, y: 330, w: 20, h: 20 } },
            { id: '0.5.6', role: 'AXStaticText', value: 'x'.repeat(100), frame: { x: 300, y: 400, w: 50, h: 10 } },
          ],
        },
      ],
    },
  };
}

export function fakeHelper() {
  const calls: { method: string; params: any; opts: any }[] = [];
  const h: any = {
    calls,
    running: true,
    fail: {} as Record<string, any>,
    apps: [NOTES, MAIL, TERMINAL, SAFARI].map((a) => ({ ...a })),
    answers: {
      'permissions.status': () => ({ accessibility: true, screenRecording: true }),
      'app.windows': () => ({
        app: { ...NOTES, frontmost: false },
        windows: [
          { ...WIN, is_auxiliary: false },
          { window_id: 6, title: 'Panel', is_auxiliary: true, state: 'off_space', is_off_space: true, bounds: {} },
        ],
      }),
      'app.screenshot': () => ({
        jpeg: 'JPEG',
        mimeType: 'image/jpeg',
        width: 1000,
        height: 800,
        frame: { width: 1000, height: 800 },
        pixelsPerPoint: 2,
        window: WIN,
        tree: tree(),
      }),
      'app.zoom': () => ({ jpeg: 'ZOOM', mimeType: 'image/jpeg', width: 400, height: 200 }),
      'app.press': () => ({ ok: true, route: 'ax', center: { x: 130, y: 70 } }),
      'app.click': () => ({ ok: true, route: 'pid' }),
      'app.setText': () => ({ ok: true, route: 'ax', effect: 'confirmed' }),
      'app.key': () => ({ ok: true, route: 'pid', effect: 'unverifiable' }),
      'app.scroll': () => ({ ok: true, route: 'ax', value: 0.6 }),
      'app.drag': () => ({ ok: true, route: 'pid' }),
      'app.focus': () => ({ ok: true, route: 'ax', moved: true }),
      'app.menu': (p: any) =>
        p.path
          ? { ok: true, route: 'ax' }
          : {
              ok: true,
              items: [
                { title: 'New', shortcut: '⌘N' },
                { title: 'Open Recent', submenu: true },
                { title: 'Close', enabled: false },
                { title: 'Wrap', checked: true },
              ],
            },
      'app.bringToCurrentSpace': () => ({ ok: true, state: 'visible', changed: true }),
      'app.cancel': (p: any) => {
        h.cancelled.add(p.batchId);
        return { cancelled: true };
      },
      // the helper's app.batch: gated once, each step as its own request would run, stopping at the first failure or a cancel
      'app.batch': (p: any) => {
        const results: any[] = [];
        for (const [i, s] of p.steps.entries()) {
          if (h.cancelled.has(p.batchId))
            return { results, failedAt: i, error: { code: 6, reason: 'aborted', message: 'aborted by the user' } };
          const params = { pid: p.pid, bundleIds: p.bundleIds, ...s.params };
          calls.push({ method: s.method, params, opts: { batch: p.batchId } });
          const f = h.fail[s.method];
          if (f) {
            const e = typeof f === 'function' ? f(params) : f;
            return { results, failedAt: i, error: { reason: e.reason, message: e.message } };
          }
          const a = h.answers[s.method];
          results.push(typeof a === 'function' ? a(params) : a);
        }
        return { results, completed: results.length, gates: 1 };
      },
    } as Record<string, any>,
  };
  h.cancelled = new Set<string>();
  h.start = async () => ({});
  h.stop = () => calls.push({ method: 'stop', params: null, opts: null });
  h.listApps = async () => ({ apps: h.apps });
  h.permissionStatus = async (options: any) => h.call('permissions.status', {}, options);
  h.call = async (method: string, params: any, opts: any) => {
    calls.push({ method, params, opts });
    const f = h.fail[method];
    if (f) throw typeof f === 'function' ? f(params) : f;
    const a = h.answers[method];
    return typeof a === 'function' ? a(params) : a;
  };
  return h;
}

export const helperFailure = (reason: string, message = reason) => Object.assign(new Error(message), { reason });

export function rig(o: { saved?: any[]; apps?: any } = {}) {
  const helper = fakeHelper();
  const answers: Record<string, any> = { computerConfirm: { decision: 'allow' } };
  const { broker, asks } = recordingBroker(answers);
  const state: any = { unattended: null, unattendedAllowed: true, session: { permission: 'default' } };
  const { cu, activity, paused } = computerUse(state);
  const saved = o.saved ?? [
    { bundleId: NOTES.bundleId, name: 'Notes', level: 'full' },
    { bundleId: MAIL.bundleId, name: 'Mail', level: 'full' },
    { bundleId: TERMINAL.bundleId, name: 'Terminal', level: 'full' },
    { bundleId: SAFARI.bundleId, name: 'Safari', level: 'full' },
  ];
  const grants = { forChat: () => saved, deny: () => [] };
  const desktop = new DesktopControl({ helper, cu, grants, broker, hostPids: async () => new Set() });
  const apps = new AppScopedControl({ desktop, helper, cu, broker, ...o.apps });
  const { call, text, callsOf } = toolCalls((tool, args, ctx) => apps.run(tool, args, ctx), helper);
  const record = async (tool: string, args: any = {}, ctx?: any) => JSON.parse(await text(tool, args, ctx));
  const last = (m: string) => callsOf(m).at(-1)?.params;
  /** a screenshot of Notes' window (the coordinate frame), and a clean call log */
  const shoot = async (app = 'com.apple.Notes', chatId = 'c1') => {
    const out = await call('desktop_app_screenshot', { app }, { chatId });
    helper.calls.length = 0;
    asks.length = 0;
    return out;
  };
  return { apps, desktop, helper, cu, asks, answers, state, paused, activity, call, text, record, callsOf, last, shoot };
}
