// A fake headless Chromium on a CDP pipe, for the Host's browser service (host/src/browserHost.mjs) and the remote tabs on it:
// browser contexts, targets, flat sessions that are refused once detached, page events, and a page agent with canned ops.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PAGE_AGENT_SOURCE } = require('../../electron/capabilities/browser/pageAgent.cjs');
const AGENT_CALL = /^globalThis\.__mopilotAgent\.call\(("[^"]*"), ([\s\S]*?), (\d+)(?:, \{[\s\S]*\})?\)$/;

/** The first 24 bytes of a 1 x 1 PNG: signature, then an IHDR chunk with the size. */
const PNG_HEAD = Buffer.from('89504e470d0a1a0a0000000d49484452' + '00000001' + '00000001', 'hex');

type Msg = { id?: number; method?: string; params?: any; sessionId?: string };

export class FakeChromium {
  /** every command received, in order */
  log: { method: string; params: any; sessionId: string }[] = [];
  contexts = new Map<string, Set<string>>();
  targets = new Map<string, { ctx: string; url: string; title: string }>();
  sessions = new Map<string, string>();
  /** methods that never answer, and ones that fail with a message */
  hangs = new Set<string>();
  fails = new Map<string, string | null>();
  /** methods answered with no result at all, and failures with no message */
  bare = new Set<string>();
  /** canned results of session commands, by method */
  results = new Map<string, any>();
  /** page-agent ops (pageAgent.cjs) by name */
  ops: Record<string, (args: any) => any> = {
    state: () => ({ w: 800, h: 600, dpr: 1, sx: 0, sy: 0, visibility: 'visible', quietMs: 1000 }),
    tree: () => ({ lines: ['- button "Go" [ref_1]'], truncated: false }),
  };
  launches = 0;
  stops = 0;
  private seq = 0;
  private messageFns = new Set<(m: any) => void>();
  private closeFns = new Set<(why: string) => void>();
  closed = false;
  /** what the process wrote to stderr before it ended */
  stderr = '';
  private exitFn: (v: any) => void = () => undefined;
  /** commands whose method is in `hangs`, kept so a test can answer them later */
  held: { id: number | undefined; method: string }[] = [];

  /** Answers the first held command of `method` with `result`, as the browser would after a delay. */
  answer(method: string, result: any) {
    const i = this.held.findIndex((h) => h.method === method);
    const [h] = this.held.splice(i, 1);
    this.raw({ id: h.id, result });
  }

  pipe = {
    send: (m: Msg) => {
      if (this.closed) throw new Error('The pipe is closed.');
      queueMicrotask(() => this.handle(m));
    },
    onMessage: (fn: (m: any) => void) => {
      this.messageFns.add(fn);
      return () => this.messageFns.delete(fn);
    },
    onClose: (fn: (why: string) => void) => {
      this.closeFns.add(fn);
      return () => this.closeFns.delete(fn);
    },
    close: () => this.die('closed'),
  };

  launch = async () => {
    this.launches++;
    // a new browser: nothing of the old one is left
    this.closed = false;
    this.messageFns = new Set();
    this.closeFns = new Set();
    this.contexts.clear();
    this.targets.clear();
    this.sessions.clear();
    this.held = [];
    return {
      pipe: this.pipe,
      exited: new Promise((r) => (this.exitFn = r)),
      stop: () => {
        this.stops++;
        this.die('closed');
      },
    };
  };

  /** The browser process ends. */
  die(why = 'ended') {
    if (this.closed) return;
    this.closed = true;
    this.exitFn({ code: 1, signal: null, stderr: this.stderr });
    for (const fn of [...this.closeFns]) fn(why);
  }

  /** A CDP event from the browser (or from a session of it). */
  emit(method: string, params: any = {}, sessionId = '') {
    for (const fn of [...this.messageFns]) fn({ method, params, ...(sessionId ? { sessionId } : {}) });
  }

  /** Sends raw bytes of a message as the browser would, for a malformed one. */
  raw(m: any) {
    for (const fn of [...this.messageFns]) fn(m);
  }

  sent(method: string) {
    return this.log.filter((c) => c.method === method);
  }

  sessionOf(targetId: string) {
    return [...this.sessions].find(([, t]) => t === targetId)?.[0];
  }

  private reply(id: number | undefined, result: any) {
    this.raw({ id, result });
  }

  private fail(id: number | undefined, message: string) {
    this.raw({ id, error: { message } });
  }

  private closeTarget(targetId: string) {
    const t = this.targets.get(targetId);
    if (!t) return false;
    this.targets.delete(targetId);
    this.contexts.get(t.ctx)?.delete(targetId);
    for (const [s, tid] of [...this.sessions]) if (tid === targetId) this.sessions.delete(s);
    this.emit('Target.targetDestroyed', { targetId });
    return true;
  }

  /** A page opens a window: a new target in the opener's context. */
  popup(openerId: string, url = 'https://popup.test/') {
    const ctx = this.targets.get(openerId)!.ctx;
    const targetId = `T${++this.seq}`;
    this.targets.set(targetId, { ctx, url, title: '' });
    this.contexts.get(ctx)!.add(targetId);
    this.emit('Target.targetCreated', { targetInfo: { targetId, type: 'page', browserContextId: ctx, openerId, url } });
    return targetId;
  }

  private handle(m: Msg) {
    const { id, method = '', params = {}, sessionId = '' } = m;
    this.log.push({ method, params, sessionId });
    if (this.hangs.has(method)) return void this.held.push({ id, method });
    if (this.fails.has(method)) return this.raw({ id, error: this.fails.get(method) === null ? {} : { message: this.fails.get(method) } });
    if (this.bare.has(method)) return this.raw({ id });
    if (sessionId) return this.session(id, method, params, sessionId);
    switch (method) {
      case 'Target.setDiscoverTargets':
      case 'Browser.setDownloadBehavior':
        return this.reply(id, {});
      case 'Target.createBrowserContext': {
        const ctx = `ctx${++this.seq}`;
        this.contexts.set(ctx, new Set());
        return this.reply(id, { browserContextId: ctx });
      }
      case 'Target.createTarget': {
        const ctx = params.browserContextId;
        if (!this.contexts.has(ctx)) return this.fail(id, 'Failed to find browser context with id');
        const targetId = `T${++this.seq}`;
        this.targets.set(targetId, { ctx, url: params.url, title: '' });
        this.contexts.get(ctx)!.add(targetId);
        this.emit('Target.targetCreated', { targetInfo: { targetId, type: 'page', browserContextId: ctx, url: params.url } });
        return this.reply(id, { targetId });
      }
      case 'Target.attachToTarget': {
        if (!this.targets.has(params.targetId)) return this.fail(id, 'No target with given id found');
        const s = `S${++this.seq}`;
        this.sessions.set(s, params.targetId);
        return this.reply(id, { sessionId: s });
      }
      case 'Target.detachFromTarget':
        if (!this.sessions.delete(params.sessionId)) return this.fail(id, 'No session with given id');
        return this.reply(id, {});
      case 'Target.closeTarget':
        return this.reply(id, { success: this.closeTarget(params.targetId) });
      case 'Target.disposeBrowserContext':
        for (const t of [...(this.contexts.get(params.browserContextId) ?? [])]) this.closeTarget(t);
        this.contexts.delete(params.browserContextId);
        return this.reply(id, {});
      default:
        return this.fail(id, `'${method}' wasn't found`);
    }
  }

  private session(id: number | undefined, method: string, params: any, sessionId: string) {
    const targetId = this.sessions.get(sessionId);
    if (!targetId) return this.fail(id, 'Session with given id not found.');
    const t = this.targets.get(targetId)!;
    if (this.results.has(method)) return this.reply(id, this.results.get(method));
    switch (method) {
      case 'Target.getTargetInfo':
        return this.reply(id, { targetInfo: { targetId, url: t.url, title: t.title, type: 'page' } });
      case 'Page.getNavigationHistory':
        return this.reply(id, { currentIndex: 0, entries: [{ id: 1, url: t.url }] });
      case 'Page.navigate': {
        t.url = params.url;
        t.title = `Title of ${params.url}`;
        const frameId = targetId;
        this.reply(id, { frameId, loaderId: `L${++this.seq}` });
        this.emit('Page.frameStartedLoading', { frameId }, sessionId);
        this.emit('Page.frameNavigated', { frame: { id: frameId, url: params.url } }, sessionId);
        this.emit('Page.frameStoppedLoading', { frameId }, sessionId);
        return;
      }
      case 'Page.captureScreenshot':
        // a PNG, which the app decodes, starts as one does (signature, IHDR) before the request in words, as the app checks it before decoding a Host's screenshot; the pane's JPEG frame is shown as it is
        return this.reply(id, {
          data: Buffer.concat([params.format === 'png' ? PNG_HEAD : Buffer.alloc(0), Buffer.from(`${params.format}:${targetId}`)]).toString(
            'base64',
          ),
        });
      case 'Page.getLayoutMetrics':
        return this.reply(id, { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } });
      case 'Page.getFrameTree':
        return this.reply(id, { frameTree: { frame: { id: targetId } } });
      case 'Page.createIsolatedWorld':
        return this.reply(id, { executionContextId: 7 });
      case 'Runtime.evaluate': {
        if (params.expression === 'navigator.userAgent') return this.reply(id, { result: { value: 'HeadlessChrome/130' } });
        if (params.expression === `${PAGE_AGENT_SOURCE}, true`) return this.reply(id, { result: { value: true } });
        const m = AGENT_CALL.exec(params.expression);
        if (m) {
          const value = this.ops[JSON.parse(m[1])]?.(JSON.parse(m[2]));
          return this.reply(id, { result: { value: { value, seq: 1 } } });
        }
        return this.reply(id, { result: { type: 'undefined' } });
      }
      default:
        return this.reply(id, {});
    }
  }
}

/** Timers the test fires by hand. */
export function timers() {
  const live = new Map<number, { fn: () => void; ms: number }>();
  /** every timer ever set, for one that fires although it was cleared */
  const all: (() => void)[] = [];
  let n = 0;
  return {
    all,
    setTimer: ((fn: () => void, ms: number) => {
      const id = ++n;
      live.set(id, { fn, ms });
      all.push(fn);
      return { id, unref() {} };
    }) as any,
    clearTimer: ((t: any) => void live.delete(t?.id)) as any,
    pending: () => [...live.values()].map((t) => t.ms),
    fire(ms: number) {
      for (const [id, t] of [...live]) if (t.ms === ms) live.delete(id), t.fn();
    },
  };
}
