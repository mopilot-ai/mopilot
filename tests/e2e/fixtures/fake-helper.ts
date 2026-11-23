// A stand-in for "MoPilot.app": a unix socket speaking the helper's newline-delimited
// JSON-RPC, so the app's computer use runs end to end without touching the real screen. main connects
// to it through SAGE_CU_FAKE_HELPER instead of launching the helper. The frontmost app is always
// Notes; TextEdit also runs, behind it (background control works there). Every request is recorded,
// and so is each step of an app.batch (with the batch's id).
import net from 'node:net';
import fs from 'node:fs';

// a 1×1 transparent PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const NOTES = { pid: 4242, bundleId: 'com.apple.Notes', name: 'Notes' };
const APP_WINDOW = {
  window_id: 77,
  title: 'Notes',
  is_main: true,
  is_minimized: false,
  is_hidden: false,
  is_off_space: false,
  is_auxiliary: false,
  state: 'visible',
  bounds: { x: 100, y: 100, width: 400, height: 300 },
};
const TEXTEDIT = { pid: 4343, bundleId: 'com.apple.TextEdit', name: 'TextEdit' };
const TEXTEDIT_WINDOW = { ...APP_WINDOW, window_id: 88, title: 'Untitled' };
const APPS = [NOTES, TEXTEDIT];
/** Each app's window: Notes has a New Note button; TextEdit a Bold button, the document and a Delete button. */
const WINDOWS: Record<string, { window: typeof APP_WINDOW; children: object[] }> = {
  [NOTES.bundleId]: {
    window: APP_WINDOW,
    children: [
      { id: '0.0', role: 'AXButton', title: 'New Note', frame: { x: 110, y: 110, w: 20, h: 20 }, actions: ['AXPress'] },
      { id: '0.1', role: 'AXTextArea', value: '', frame: { x: 100, y: 150, w: 400, h: 250 }, settable: true },
    ],
  },
  [TEXTEDIT.bundleId]: {
    window: TEXTEDIT_WINDOW,
    children: [
      { id: '0.0', role: 'AXButton', title: 'Bold', frame: { x: 110, y: 110, w: 20, h: 20 }, actions: ['AXPress'] },
      { id: '0.1', role: 'AXTextArea', value: '', frame: { x: 100, y: 150, w: 400, h: 200 }, settable: true },
      { id: '0.2', role: 'AXButton', title: 'Delete', frame: { x: 460, y: 110, w: 30, h: 20 }, actions: ['AXPress'] },
    ],
  },
};
/** The app an app.* request is for: its pid, else its bundle id. */
const appOf = (params: any) => APPS.find((a) => a.pid === params.pid) ?? APPS.find((a) => a.bundleId === params.bundleIds?.[0]) ?? NOTES;
const matches = (a: typeof NOTES, q: string) => [a.name, a.bundleId].some((n) => n.toLowerCase() === String(q).toLowerCase());

export interface FakeHelper {
  socket: string;
  /** every request main sent, in order; a step of an app.batch comes after it, with the batch's id */
  log: { method: string; params: any; batch?: string }[];
  /** epoch ms (fractional) when main's request arrived, parallel to `log` (kept apart so a test may compare log entries whole) */
  stamps: number[];
  /** what permissions.status answers */
  permissions: { accessibility: boolean; screenRecording: boolean; inputMonitoring: boolean };
  /** true: a missing permission makes screenshots (Screen Recording) and input (Accessibility) fail, as the real helper does */
  enforcePermissions: boolean;
  /** false: ocr.elements doesn't exist, as in a helper without it */
  ocr: boolean;
  /** what input.idle answers: seconds since the last physical input */
  idle: { seconds: number };
  /** true: an app.batch gets no answer until main cancels it (app.cancel), as a long batch Stop interrupts */
  holdBatches: boolean;
  /** method -> ms: the answer to that method waits this long (a slow helper); 0 or absent: at once */
  latency: Record<string, number>;
  /** ms from main's app.click request to the click event (and to its answer): the real helper's own work (IPC, dispatch check, pre-click settle) took about 150 ms (#3810); 0 clicks at once */
  clickMs: number;
  /**
   * Calendar and Reminders access as macOS has it (EventKit, MoMo's sources): `request` shows the "prompt" the first
   * time (notDetermined) and the user answers `onPrompt`; afterwards it just answers. A test turns a switch on by
   * setting the grant.
   */
  eventkit: { calendar: string; reminders: string; onPrompt: string; nextId: number; items: Record<string, any>[] };
  /** what speech.status says about on-device recognition for the language (false: its model isn't on this Mac) */
  speech: { onDevice: boolean };
  /** sends main a control.paused notification, as a physical Esc or a take-over would */
  pause(reason: 'escape' | 'takeover'): void;
  /** sends main a record.event notification, as a person's click or key while recording would (record.start was asked) */
  record(event: object): void;
  close(): Promise<void>;
}

export async function startFakeHelper(socket: string): Promise<FakeHelper> {
  // a named pipe (Windows) is no file to clear
  if (!socket.startsWith('\\\\.\\pipe\\')) fs.rmSync(socket, { force: true });
  const log: FakeHelper['log'] = [];
  const stamps: number[] = [];
  const hold = { on: false };
  const latency: Record<string, number> = {};
  const clickMs = { value: 150 };
  const stamp = () => performance.timeOrigin + performance.now();
  /** held app.batch requests by batch id: answers them when main cancels */
  const heldBatches = new Map<string, () => void>();
  const permissions = { accessibility: true, screenRecording: true, inputMonitoring: true };
  const conns = new Set<net.Socket>();
  const control = { controlling: false, paused: null as string | null };
  const idle = { seconds: 1 };
  const ocrState = { on: true };
  const eventkit = {
    calendar: 'notDetermined',
    reminders: 'notDetermined',
    onPrompt: 'granted',
    nextId: 0,
    items: [] as Record<string, any>[],
  };
  const speech = { onDevice: true };
  const enforce = { on: false };
  const denied = (p: string) => Object.assign(new Error(`${p} permission not granted`), { code: 1, reason: 'permission_denied' });
  const verified = (params: any) => ({
    ...(params.verify ? { verify: { effect: 'confirmed', evidence: ['the window changed'], settleMs: 5 } } : {}),
    ...(params.thumbnail ? { thumb: PNG } : {}),
  });
  const answer = (method: string, params: any): any => {
    switch (method) {
      case 'hello':
        return { pid: process.pid, version: '0.0.0-fake', bundleId: 'ai.mopilot.code.computer-use', permissions };
      case 'permissions.status':
      case 'permissions.request':
        return permissions;
      case 'permissions.openSettings':
        return { opened: true };
      case 'glow.start':
      case 'glow.stop':
        return { ok: true };
      case 'target.info':
        return NOTES;
      case 'screenshot':
        if (enforce.on && !permissions.screenRecording) throw denied('screenRecording');
        // the desktop_* tools ask for granted apps' windows only: the answer says which apps it shows
        if (Array.isArray(params.includeBundleIds)) {
          const included = params.includeBundleIds.filter((id: string) => id.toLowerCase() === NOTES.bundleId.toLowerCase());
          return {
            jpeg: PNG,
            mimeType: 'image/jpeg',
            width: 1,
            height: 1,
            display: { id: 1, x: 0, y: 0, width: 1, height: 1 },
            pixelsPerPoint: 1,
            included,
          };
        }
        return { png: PNG, width: 1, height: 1, display: { id: 1, x: 0, y: 0, width: 1, height: 1 }, pixelsPerPoint: 1 };
      // desktop control (the desktop_* tools): Notes is installed, running and frontmost; TextEdit runs behind it
      case 'apps.list':
        return { apps: APPS.map((a) => ({ ...a, frontmost: a === NOTES, hidden: false })) };
      case 'apps.resolve':
        return {
          apps: (params.queries ?? []).map((q: string) => {
            const a = APPS.find((x) => matches(x, q));
            return a
              ? { query: q, app: { ...a, displayName: a.name, path: `/System/Applications/${a.name}.app`, running: true } }
              : { query: q, app: null };
          }),
        };
      case 'apps.open':
        return { ...NOTES, frontmost: true };
      case 'displays.list':
        return { displays: [{ id: 1, x: 0, y: 0, width: 1, height: 1, scale: 1, main: true, name: 'Fake display' }] };
      case 'input.cursor':
        return { x: 0, y: 0 };
      case 'ax.press':
      case 'ax.focus':
        return { ok: true, route: 'ax', center: { x: 20, y: 20 } };
      // the focused field: empty and unreadable here, so typed text is never claimed confirmed
      case 'text.focused':
        return { pid: NOTES.pid, bundleId: NOTES.bundleId, role: 'AXTextArea', settable: false };
      case 'text.insert':
        return { ok: false, reason: 'not_settable' };
      case 'apps.hideOthers':
        return { hidden: [] };
      case 'apps.restore':
        return { ok: true };
      case 'pasteboard.save':
        return { saved: true, items: 1 };
      case 'pasteboard.restore':
        return { restored: !!params.apply };
      case 'ax.snapshot':
        return {
          app: NOTES,
          nodes: 2,
          truncated: false,
          root: {
            id: '0',
            role: 'AXApplication',
            title: 'Notes',
            children: [{ id: '0.0', role: 'AXButton', title: 'New Note', frame: { x: 10, y: 10, w: 20, h: 20 } }],
          },
        };
      case 'ocr.elements':
        if (!ocrState.on) throw Object.assign(new Error('unknown method ocr.elements'), { code: -32601, reason: 'method_not_found' });
        return {
          app: NOTES,
          elements: [
            { id: 'ax:0.0', text: 'New Note', role: 'AXButton', source: 'ax', frame: { x: 10, y: 10, w: 20, h: 20 } },
            { id: 'ocr:0', text: 'Hello world', role: 'text', source: 'ocr', confidence: 0.95, frame: { x: 40, y: 60, w: 80, h: 14 } },
          ],
          truncated: false,
          display: { id: 1, x: 0, y: 0, width: 1, height: 1 },
        };
      case 'speech.status':
      case 'speech.request':
        return { authorization: 'authorized', locale: 'en-US', available: true, onDevice: speech.onDevice };
      case 'speech.transcribe':
        return { text: 'hello from the fake recognizer', locale: 'en-US' };
      case 'eventkit.status':
        return { protocol: 2, calendar: eventkit.calendar, reminders: eventkit.reminders };
      case 'eventkit.request': {
        const entity = params.entity as 'calendar' | 'reminders';
        const asked = eventkit[entity] === 'notDetermined';
        if (asked) eventkit[entity] = eventkit.onPrompt;
        return { protocol: 2, calendar: eventkit.calendar, reminders: eventkit.reminders, asked };
      }
      case 'calendar.calendars':
      case 'reminders.lists':
        return { items: [{ id: 'c1', title: 'Work', account: 'iCloud' }] };
      // nothing on the calendar or in the lists: a MoMo read that gets this far says so
      case 'calendar.events':
      case 'reminders.items':
        return { items: [], truncated: false };
      // MoMo's writes (eventKit protocol 2): the items it made, so a spec can see what a card allowed and what an undo removed
      case 'calendar.create':
      case 'reminders.create': {
        const id = `${method === 'calendar.create' ? 'ev' : 'rem'}-${++eventkit.nextId}`;
        eventkit.items.push({ id, ...params });
        return method === 'calendar.create' ? { id, calendar: 'Work' } : { id, list: 'Home' };
      }
      case 'reminders.get': {
        const item = eventkit.items.find((i) => i.id === params.id);
        if (!item) throw Object.assign(new Error('no such reminder'), { reason: 'not_found' });
        return { id: item.id, title: item.title, list: 'Home', done: item.done === true };
      }
      case 'reminders.complete': {
        const item = eventkit.items.find((i) => i.id === params.id);
        if (!item) throw Object.assign(new Error('gone'), { reason: 'gone' });
        item.done = params.done === true;
        return { id: item.id };
      }
      case 'calendar.delete':
      case 'reminders.delete': {
        const at = eventkit.items.findIndex((i) => i.id === params.id);
        if (at < 0) throw Object.assign(new Error('gone'), { reason: 'gone' });
        eventkit.items.splice(at, 1);
        return { id: params.id };
      }
      case 'deny.set':
        return { rules: 13 + (params.bundleIds?.length ?? 0) };
      case 'control.acquire':
        Object.assign(control, { controlling: true, paused: null });
        return { ...control };
      case 'control.release':
        Object.assign(control, { controlling: false, paused: null });
        return { ...control };
      case 'control.resume':
        control.paused = null;
        return { ...control };
      case 'control.state':
        return { ...control };
      case 'input.idle':
        return { seconds: idle.seconds };
      // watch-and-record: on until record.stop
      case 'record.start':
        return { started: true };
      case 'record.stop':
        return { stopped: true };
      case 'shutdown':
        return {};
      // background control (the desktop_app_* tools): each app has one window, 400x300 points at (100, 100), captured at 2x.
      // An input action asked to verify its effect reports one change it saw; one asked for a thumbnail brings one back.
      case 'app.windows': {
        const a = appOf(params);
        return { app: { ...a, hidden: false, frontmost: a === NOTES }, windows: [WINDOWS[a.bundleId].window] };
      }
      case 'app.screenshot': {
        const a = appOf(params);
        const { window, children } = WINDOWS[a.bundleId];
        return {
          jpeg: PNG,
          mimeType: 'image/jpeg',
          width: 800,
          height: 600,
          frame: { width: 800, height: 600 },
          pixelsPerPoint: 2,
          window,
          app: a,
          tree: { nodes: children.length + 1, truncated: false, root: { id: '0', role: 'AXWindow', children } },
          ...(params.thumbnail ? { thumb: PNG } : {}),
        };
      }
      case 'app.zoom':
        return { jpeg: PNG, mimeType: 'image/jpeg', width: 10, height: 10 };
      case 'app.press':
        return { ok: true, route: 'ax', action: params.action ?? 'AXPress', center: { x: 120, y: 120 }, ...verified(params) };
      case 'app.setText':
        return { ok: true, route: 'ax', effect: 'confirmed', ...verified(params) };
      case 'app.key':
        return { ok: true, route: 'pid', effect: 'unverifiable', ...verified(params) };
      case 'app.focus':
        return { ok: true, route: 'ax', moved: true };
      case 'app.menuRefresh':
        return { refreshed: true };
      case 'app.menu':
        return params.path
          ? { ok: true, route: 'ax', pressed: params.path }
          : { ok: true, path: params.list ?? [], items: [{ title: 'New Note', shortcut: '⌘N' }] };
      case 'app.bringToCurrentSpace':
        return { ok: true, state: 'visible', changed: false };
      case 'app.click':
      case 'app.drag':
      case 'app.scroll':
        return { ok: true, route: 'pid', ...verified(params) };
      // several steps at once: each answered as its own request would be, stopping at the first that fails
      case 'app.batch': {
        const run = () => {
          const results: any[] = [];
          for (const step of params.steps ?? []) {
            log.push({ method: step.method, params: step.params ?? {}, batch: params.batchId });
            stamps.push(stamp());
            try {
              results.push(answer(step.method, step.params ?? {}));
            } catch (e: any) {
              return { results, error: { reason: e.reason, message: e.message } };
            }
          }
          return { results };
        };
        if (!hold.on) return run();
        return new Promise((resolve) =>
          heldBatches.set(params.batchId, () => resolve({ results: [], error: { reason: 'aborted', message: 'the batch was cancelled' } })),
        );
      }
      case 'app.cancel': {
        const held = heldBatches.get(params.batchId);
        heldBatches.delete(params.batchId);
        held?.();
        return { cancelled: !!held };
      }
      default:
        if (method.startsWith('input.') && enforce.on && !permissions.accessibility) throw denied('accessibility');
        if (method.startsWith('input.')) {
          if (control.paused)
            throw Object.assign(new Error(`paused by the user (${control.paused}); resume first`), { code: 4, reason: 'paused' });
          return { ok: true };
        }
        throw Object.assign(new Error(`unknown method ${method}`), { code: -32601, reason: 'method_not_found' });
    }
  };
  const server = net.createServer((c) => {
    conns.add(c);
    c.on('close', () => conns.delete(c));
    c.on('error', () => {});
    c.setEncoding('utf8');
    let buf = '';
    c.on('data', (chunk: string) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        log.push({ method: msg.method, params: msg.params ?? {} });
        stamps.push(stamp() + (msg.method === 'app.click' ? clickMs.value : 0));
        const send = (body: object) => !c.destroyed && c.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body }) + '\n');
        // the real helper answers a click after its post-click settle (about 105-138 ms) and says early, as the mouse-down goes out, that it did (click.dispatched)
        const clicked = msg.method === 'app.click';
        const wait = (latency[msg.method] ?? 0) + (clicked ? clickMs.value + (clickMs.value > 0 ? 105 : 0) : 0);
        if (clicked && typeof msg.params?.signal === 'string') {
          const note = JSON.stringify({ jsonrpc: '2.0', method: 'click.dispatched', params: { signal: msg.params.signal } }) + '\n';
          setTimeout(() => !c.destroyed && c.write(note), clickMs.value);
        }
        const reply = (body: object) => (wait > 0 ? void setTimeout(() => send(body), wait) : send(body));
        const fail = (e: any) => reply({ error: { code: e.code ?? -32603, message: e.message, data: { reason: e.reason } } });
        try {
          // an answer may come later (a held batch)
          Promise.resolve(answer(msg.method, msg.params ?? {})).then((result) => reply({ result }), fail);
        } catch (e: any) {
          fail(e);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return {
    socket,
    log,
    stamps,
    permissions,
    latency,
    get clickMs() {
      return clickMs.value;
    },
    set clickMs(v) {
      clickMs.value = v;
    },
    eventkit,
    speech,
    idle,
    get enforcePermissions() {
      return enforce.on;
    },
    set enforcePermissions(v) {
      enforce.on = v;
    },
    get holdBatches() {
      return hold.on;
    },
    set holdBatches(v) {
      hold.on = v;
    },
    get ocr() {
      return ocrState.on;
    },
    set ocr(v) {
      ocrState.on = v;
    },
    pause(reason) {
      control.paused = reason;
      for (const c of conns) c.write(JSON.stringify({ jsonrpc: '2.0', method: 'control.paused', params: { reason } }) + '\n');
    },
    record(event) {
      for (const c of conns) c.write(JSON.stringify({ jsonrpc: '2.0', method: 'record.event', params: event }) + '\n');
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of conns) c.destroy();
        server.close(() => resolve());
      }),
  };
}
