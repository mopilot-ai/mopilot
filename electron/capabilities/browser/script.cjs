// browser_script: many browser steps in one tool call, written as JavaScript against a Playwright-style
// API (scriptRuntime.cjs). The script runs in a worker thread, in a node:vm context with no Node globals;
// each API call comes back here as one operation on the shared BrowserHost (host.cjs) for the chat's own
// tabs, with the same checks as the browser_* tools: site permission for navigations, a denied or
// read-only site refusing actions, take over, JavaScript confirmations and the per-tab action queue,
// and the site risk checks (a high-risk site asks before it is read and for each action, sensitive
// actions ask, password fields refuse typing) through the same `gate` and `act` as the tools.
// Locators resolve in the page agent (pageAgent.cjs query) and actions wait until their element is
// there, alone, visible, enabled and not covered.
const { ownTable } = require('../../../shared/ownTable.mjs');
const { ToolError } = require('../contract/registry.cjs');
const { withPagingNote } = require('../../../shared/pagingNote.mjs');
const { checkLookOnly, lookTab, peekValue, lookRefusal } = require('./scriptLookOnly.cjs');
const { lineOf, hintOf, failureCode, capped } = require('./scriptFailure.cjs');
const { modifierBits, oneLine } = require('./host.cjs');
const { holdMs } = require('./heldInput.cjs');
const { ScriptSession, ScriptSessions, WORKER_SOURCE, LOG_MAX } = require('./scriptSessions.cjs');

const DEFAULT_MS = 30_000;
const MAX_MS = 55_000;
const LOCATOR_MS = 10_000;
const CODE_MAX = 100_000;
const RESULT_MAX = 20_000;
const IMAGES_MAX = 6;
const LOAD_STATES = new Set(['load', 'domcontentloaded', 'networkidle']);
const BUTTONS = new Set(['left', 'right', 'middle']);
const { REFERENCE, DESCRIPTION } = require('./scriptDoc.cjs');
const SPEC = {
  policy: 'act',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description:
          'The body of an async function, for example: await tab.goto("https://example.com"); await tab.getByRole("link", { name: "More" }).click(); return await tab.title();',
      },
      timeoutMs: { type: 'integer', minimum: 1000, maximum: MAX_MS, description: 'How long the whole script may run (default 30000).' },
    },
    required: ['code'],
  },
};

/** @returns {Promise<void>} */
const pause = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/**
 * The operations a script calls, for one browser_script call. `gate(tab, need)` refuses a denied or
 * read-only site (and asks before a high-risk one is used), `act(tab, action)` checks an action before
 * it runs (password fields, sensitive actions, high-risk sites), `navigate(tab, url)` opens a URL (or
 * back/forward/reload) asking for a new site, `confirmed(tab, summary)` asks for page JavaScript.
 * Screenshots go to `images`.
 */
function createScriptOps({
  tabs,
  ctx,
  gate,
  // no action gate configured: nothing is asked
  act = async (_tab, _summary) => false,
  navigate,
  confirmed,
  images,
  deadline,
  wait = pause,
  now = Date.now,
}) {
  const chatId = ctx.chatId;
  const left = () => Math.max(0, deadline - now());
  /** A press-and-hold `delay` (ms) as a hold length: it ends by the script's deadline, so nothing stays held after it. */
  const hold = (delay) => Math.min(holdMs(delay, 1), left());
  const budget = (ms, dflt = LOCATOR_MS) => Math.max(0, Math.min(ms == null || !Number.isFinite(Number(ms)) ? dflt : Number(ms), left()));
  const tabOf = (id) => tabs.resolve(chatId, id ?? null);

  /** fn(tab) alone on the tab, after the usual checks; need: null, 'read' or 'write'. */
  const on = async (id, need, fn, ready = {}) => {
    const tab = await tabOf(id);
    return tabs.run(tab, async () => {
      await tabs.ready(tab, chatId, ready);
      if (need) await gate(lookTab(ctx, tab), need);
      return fn(tab);
    });
  };

  const keep = (tab, shot, what) => {
    if (images.length >= IMAGES_MAX) throw new ToolError(`A script can return at most ${IMAGES_MAX} screenshots.`, 'limit');
    images.push({ tab: tab.id, url: tab.url, what, ...shot });
    return { screenshot: images.length, tab: tab.id, width: shot.width, height: shot.height };
  };

  const strict = (q, desc) => {
    if (q.count > 1)
      throw new ToolError(
        `${desc} matched ${q.count} elements (${q.desc.join(', ')}${q.count > q.desc.length ? ', …' : ''}). Make it match one: first(), nth(i), filter({ hasText }) or a more specific locator.`,
        'strict',
      );
  };

  /** Re-resolves the locator until `check(q)` is { done, value }, or times out with its last { wait } reason. */
  async function until(tab, a, ms, check) {
    const end = now() + ms;
    for (;;) {
      let r;
      try {
        r = await check(await tabs.query(tab, a.steps));
      } catch (e) {
        if (!(e instanceof ToolError) || e.code !== 'stale_ref') throw e;
        r = { wait: 'to stay attached (the page replaced it)' };
      }
      if (r.done) return r.value;
      if (now() >= end) throw new ToolError(`Timed out after ${ms} ms waiting for ${a.desc} ${r.wait}.`, 'timeout');
      await wait(Math.min(200, end - now()), ctx.signal);
    }
  }

  /** The one element of the locator, once it is there (and, unless `force`, visible, enabled, editable as asked). */
  const target = (tab, a, { visible = true, enabled = true, editable = false, point = false } = {}) => {
    const force = !!a.options?.force;
    return until(tab, a, budget(a.timeoutMs), async (q) => {
      if (!q.count) return { wait: 'to appear (nothing matches yet)' };
      strict(q, a.desc);
      const ref = q.refs[0];
      const [s] = await tabs.inspect(tab, q.sessionId, [ref], 'state');
      if (!s) return { wait: 'to stay attached (the page replaced it)' };
      if (!force && visible && !s.visible) return { wait: 'to be visible' };
      if (!force && enabled && !s.enabled) return { wait: 'to be enabled' };
      if (!force && editable && !s.editable) return { wait: 'to be editable' };
      if (!point) return { done: true, value: { ref, s, q } };
      const st = await tabs.ready(tab, chatId, { input: true });
      const loc = await tabs.locate(tab, ref, { hit: true });
      if (loc.cover && !force) return { wait: `to receive the click (${loc.cover} is in front of it)` };
      const pos = a.options?.position;
      const xy =
        pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) ? [loc.x - loc.w / 2 + pos.x, loc.y - loc.h / 2 + pos.y] : [loc.x, loc.y];
      return { done: true, value: { ref, s, st, p: await tabs.point(tab, st, { coordinate: xy }) } };
    });
  };

  const clickAt = async (tab, p, o = {}) => {
    const r = await tabs.click(tab, p, {
      button: BUTTONS.has(o.button) ? o.button : 'left',
      clickCount: Math.max(1, Math.min(3, Math.round(Number(o.clickCount) || 1))),
      modifiers: modifierBits(o.modifiers),
      // Playwright's delay: ms between pressing the button and letting go, within what is left of the script's time
      holdMs: hold(o.delay),
    });
    if (r !== 'dialog') await tabs.settle(tab);
  };

  /** Locator actions: (tab, a) where a = { steps, desc, value, options, timeoutMs }. */
  const ACT = ownTable({
    async click(tab, a) {
      const { ref, p } = await target(tab, a, { point: true });
      // a card shown meanwhile: the element is clicked where it is now (the page may have scrolled under the card)
      const asked = await act(tab, { kind: 'click', target: { ref }, summary: `click ${a.desc}`, messageKind: a.options?.messageKind });
      await clickAt(tab, asked ? (await target(tab, a, { point: true })).p : p, a.options);
    },
    async hover(tab, a) {
      const { p } = await target(tab, a, { point: true, enabled: false });
      await tabs.hover(tab, p);
      await tabs.settle(tab, { grace: 100 });
    },
    async fill(tab, a) {
      const { ref, s } = await target(tab, a, { editable: true });
      if (s.tag === 'select') throw new ToolError(`${a.desc} is a <select>: use selectOption().`, 'bad_args');
      await act(tab, { kind: 'fill', value: String(a.value), target: { ref }, summary: `fill ${a.desc}` });
      await tabs.formInput(tab, ref, String(a.value));
      await tabs.settle(tab, { grace: 100 });
    },
    async type(tab, a) {
      const { ref } = await target(tab, a);
      await act(tab, { kind: 'type', text: String(a.value), target: { ref }, summary: `type into ${a.desc}` });
      await tabs.focus(tab, ref);
      await tabs.ready(tab, chatId, { input: true });
      const r = await tabs.typeText(tab, String(a.value));
      if (r !== 'dialog') await tabs.settle(tab, { grace: 100 });
    },
    async press(tab, a) {
      const { ref } = await target(tab, a, { visible: false, enabled: false });
      const summary = `press ${oneLine(a.value, 60)} in ${a.desc}`;
      await act(tab, { kind: 'key', keys: String(a.value), target: { ref }, summary, messageKind: a.options?.messageKind });
      await tabs.focus(tab, ref);
      await tabs.ready(tab, chatId, { input: true });
      const r = await tabs.keys(tab, String(a.value), 1, { holdMs: hold(a.options.delay) });
      if (r !== 'dialog') await tabs.settle(tab);
    },
    async check(tab, a) {
      const want = !!a.value;
      const { ref, s } = await target(tab, a, { visible: false });
      if (s.checked === null) throw new ToolError(`${a.desc} is not a checkbox, radio or switch.`, 'bad_args');
      if (s.checked === want) return;
      if (!want && s.type === 'radio')
        throw new ToolError(`${a.desc} is a radio button: check another option instead of unchecking it.`, 'bad_args');
      await act(tab, { kind: 'check', target: { ref }, summary: `${want ? 'check' : 'uncheck'} ${a.desc}` });
      if (s.visible || a.options?.force) {
        const { p } = await target(tab, a, { point: true });
        await clickAt(tab, p);
      } else if (s.tag === 'input') {
        await tabs.formInput(tab, ref, want);
        await tabs.settle(tab, { grace: 100 });
      } else throw new ToolError(`${a.desc} is not visible, so it can't be clicked.`, 'bad_args');
      // verify, unless the element went away or was replaced (the page moved on)
      const after = await tabs.query(tab, a.steps);
      const [state] = after.count ? await tabs.inspect(tab, after.sessionId, after.refs.slice(0, 1), 'state') : [null];
      if (state && state.checked !== want) throw new ToolError(`Clicking ${a.desc} did not ${want ? 'check' : 'uncheck'} it.`, 'failed');
    },
    async select(tab, a) {
      const { ref } = await target(tab, a);
      await act(tab, { kind: 'select', summary: `choose an option in ${a.desc}` });
      const values = await tabs.selectOptions(tab, ref, Array.isArray(a.value) ? a.value : []);
      await tabs.settle(tab, { grace: 100 });
      return values;
    },
    async focus(tab, a) {
      const { ref } = await target(tab, a, { visible: false, enabled: false });
      await tabs.focus(tab, ref);
    },
    async scroll(tab, a) {
      const { ref } = await target(tab, a, { enabled: false });
      await tabs.scrollTo(tab, ref);
      await tabs.settle(tab, { grace: 100 });
    },
  });
  const READS_ONLY = new Set(['hover', 'focus', 'scroll']);

  /** Locator reads: (tab, a) where a = { steps, desc, what, name, timeoutMs }. */
  async function read(tab, a) {
    switch (a.what) {
      case 'count':
        return (await tabs.query(tab, a.steps)).count;
      case 'isVisible': {
        const q = await tabs.query(tab, a.steps);
        if (!q.count) return false;
        strict(q, a.desc);
        const [s] = await tabs.inspect(tab, q.sessionId, q.refs, 'state');
        return !!s?.visible;
      }
      case 'allTextContents':
      case 'allInnerTexts': {
        const q = await tabs.query(tab, a.steps);
        const out = await tabs.inspect(tab, q.sessionId, q.refs, a.what === 'allTextContents' ? 'textContent' : 'innerText');
        return out.filter((v) => v !== null);
      }
      case 'boundingBox': {
        const { ref, s } = await target(tab, a, { visible: false, enabled: false });
        if (!s.visible) return null;
        const loc = await tabs.locate(tab, ref, { scroll: false });
        return { x: loc.x - loc.w / 2, y: loc.y - loc.h / 2, width: loc.w, height: loc.h };
      }
      case 'screenshot': {
        const { ref } = await target(tab, a, { enabled: false });
        const loc = await tabs.locate(tab, ref);
        const st = await tabs.ready(tab, chatId, { input: true });
        return keep(
          tab,
          await tabs.capture(tab, st, { region: [loc.x - loc.w / 2, loc.y - loc.h / 2, loc.x + loc.w / 2, loc.y + loc.h / 2] }),
          a.desc,
        );
      }
      case 'isEnabled':
      case 'isEditable':
      case 'isChecked': {
        const { s } = await target(tab, a, { visible: false, enabled: false });
        if (a.what === 'isChecked' && s.checked === null) throw new ToolError(`${a.desc} is not a checkbox, radio or switch.`, 'bad_args');
        return a.what === 'isEnabled' ? s.enabled : a.what === 'isEditable' ? s.editable : s.checked === true;
      }
      case 'innerText':
      case 'textContent':
      case 'innerHTML':
      case 'attr':
      case 'value': {
        const { ref, q } = await target(tab, a, { visible: false, enabled: false });
        const [v] = await tabs.inspect(tab, q.sessionId, [ref], a.what, a.name);
        if (v && typeof v === 'object') throw new ToolError(v.error, 'bad_args');
        if (v === null && a.what !== 'attr') throw new ToolError(`${a.desc} went away while reading it.`, 'stale_ref');
        return v;
      }
      default:
        throw new ToolError(`Unknown locator read: ${oneLine(a.what, 40)}`, 'bad_args');
    }
  }

  const point = async (tab, x, y) => {
    const st = await tabs.ready(tab, chatId, { input: true });
    return { st, p: x == null && y == null ? { x: st.w / 2, y: st.h / 2 } : await tabs.point(tab, st, { coordinate: [x, y] }) };
  };

  const OPS = {
    sleep: (a) => wait(Math.max(0, Math.min(Number(a.ms) || 0, left())), ctx.signal),
    'tab.resolve': async () => ({ id: (await tabOf(null)).id }),
    'tabs.new': async (a) => {
      const tab = await tabs.create(chatId, { focus: false });
      if (a.url)
        await tabs.run(tab, async () => {
          await tabs.ready(tab, chatId);
          await navigate(tab, String(a.url));
        });
      return { id: tab.id };
    },
    'tabs.list': () => {
      const cur = tabs.current(chatId);
      return tabs.list(chatId).map((t) => ({ id: t.id, title: t.title, url: t.url, current: t === cur }));
    },
    'tabs.selected': () => {
      const t = tabs.current(chatId);
      return t ? { id: t.id } : null;
    },
    'tabs.get': async (a) => ({ id: (await tabs.resolve(chatId, String(a.id))).id }),
    'tab.goto': (a) =>
      on(a.tab, null, async (tab) => {
        await navigate(tab, String(a.url));
        return { url: lookTab(ctx, tab).url, title: tab.title };
      }),
    'tab.back': (a) => on(a.tab, null, (tab) => navigate(tab, 'back')),
    'tab.forward': (a) => on(a.tab, null, (tab) => navigate(tab, 'forward')),
    'tab.reload': (a) => on(a.tab, null, (tab) => navigate(tab, 'reload')),
    'tab.close': async (a) => {
      await tabs.close(chatId, a.tab);
    },
    'tab.title': async (a) => lookTab(ctx, await tabOf(a.tab)).title,
    'tab.url': async (a) => lookTab(ctx, await tabOf(a.tab)).url,
    'tab.select': async (a) => {
      tabs.select(chatId, a.tab);
    },
    'tab.mark': async (a) => {
      tabs.mark(chatId, a.tab, a.status);
    },
    'tab.screenshot': (a) =>
      on(a.tab, 'read', async (tab) => {
        const st = await tabs.ready(tab, chatId, { input: true });
        if (a.fullPage) return keep(tab, await tabs.captureFull(tab), 'full page');
        const c = a.clip;
        const region = c ? [c.x, c.y, c.x + c.width, c.y + c.height] : null;
        return keep(tab, await tabs.capture(tab, st, { region, scale: a.scale }), region ? 'clip' : 'viewport');
      }),
    'tab.dialog': async (a) => {
      const tab = await tabOf(a.tab);
      await tabs.ready(tab, chatId, { allowDialog: true });
      const d = tab.dialog;
      return d ? { type: d.type, message: d.message, defaultValue: d.defaultPrompt } : null;
    },
    'tab.dialog.answer': async (a) => {
      const tab = await tabOf(a.tab);
      await tabs.ready(tab, chatId, { allowDialog: true });
      const message = tab.dialog?.message ?? '';
      // the dialog the card is about: the answer goes to no other
      const expect = tab.dialog?.own ?? null;
      await act(tab, {
        kind: 'dialog',
        accept: !!a.accept,
        message,
        summary: `${a.accept ? 'accept' : 'dismiss'} the dialog${message ? ` "${oneLine(message, 120)}"` : ''}`,
      });
      return tabs.handleDialog(tab, !!a.accept, a.text, expect);
    },
    'tab.waitForLoadState': (a) =>
      on(a.tab, null, (tab) => tabs.waitForLoad(tab, LOAD_STATES.has(a.state) ? a.state : 'load', budget(a.timeoutMs))),
    'tab.domSnapshot': (a) =>
      on(a.tab, 'read', async (tab) => {
        const { lines, truncated } = await tabs.readPage(tab, { filter: 'all', depth: 40, ref: null, maxChars: 50000 });
        return `${lines.join('\n')}${truncated ? '\n[Truncated at 50,000 characters.]' : ''}`;
      }),
    'tab.evaluate': (a) =>
      on(a.tab, ctx.lookOnly ? 'read' : 'write', async (tab) => {
        const expression = String(a.expression);
        if (ctx.lookOnly) return peekValue(ctx, tabs, tab, expression);
        await confirmed(tab, expression);
        const out = await tabs.exec(tab, `(async () => JSON.stringify({ v: await (${expression}\n) }))()`);
        return out === 'undefined' ? null : (JSON.parse(out).v ?? null);
      }),
    'tab.logs': (a) =>
      on(
        a.tab,
        'read',
        (tab) =>
          tabs
            .console(tab, { onlyErrors: !!a.onlyErrors, pattern: a.pattern || null, limit: a.limit ?? 100 })
            .map((e) => ({ level: e.level, text: e.text, at: new Date(e.at).toISOString(), source: e.source })),
        { allowDialog: true },
      ),
    'cua.click': (a) =>
      on(a.tab, 'write', async (tab) => {
        const { p } = await point(tab, a.x, a.y);
        await act(tab, { kind: 'click', target: { point: p }, summary: `click at (${Math.round(p.x)}, ${Math.round(p.y)})` });
        await clickAt(tab, p, a);
      }),
    'cua.move': (a) =>
      on(a.tab, 'read', async (tab) => {
        const { p } = await point(tab, a.x, a.y);
        await tabs.hover(tab, p);
        await tabs.settle(tab, { grace: 100 });
      }),
    'cua.scroll': (a) =>
      on(a.tab, 'read', async (tab) => {
        const { p } = await point(tab, a.x, a.y);
        await tabs.wheel(tab, p, a.dx, a.dy);
        await tabs.settle(tab, { grace: 200 });
      }),
    'cua.type': (a) =>
      on(a.tab, 'write', async (tab) => {
        await tabs.ready(tab, chatId, { input: true });
        await act(tab, { kind: 'type', text: String(a.text), summary: `type ${String(a.text).length} characters` });
        const r = await tabs.typeText(tab, String(a.text));
        if (r !== 'dialog') await tabs.settle(tab, { grace: 100 });
      }),
    'cua.keys': (a) =>
      on(a.tab, 'write', async (tab) => {
        await tabs.ready(tab, chatId, { input: true });
        await act(tab, { kind: 'key', keys: String(a.keys), summary: `press ${oneLine(a.keys, 60)}` });
        const r = await tabs.keys(tab, String(a.keys), 1, { holdMs: hold(a.delay) });
        if (r !== 'dialog') await tabs.settle(tab);
      }),
    'cua.drag': (a) =>
      on(a.tab, 'write', async (tab) => {
        const path = Array.isArray(a.path) ? a.path : [];
        if (path.length < 2) throw new ToolError('drag needs a path of at least two points.', 'bad_args');
        const from = await point(tab, path[0].x, path[0].y);
        const to = await point(tab, path[path.length - 1].x, path[path.length - 1].y);
        await act(tab, {
          kind: 'drag',
          target: { point: from.p },
          summary: `drag from (${Math.round(from.p.x)}, ${Math.round(from.p.y)}) to (${Math.round(to.p.x)}, ${Math.round(to.p.y)})`,
        });
        const r = await tabs.drag(tab, from.p, to.p);
        if (r !== 'dialog') await tabs.settle(tab);
      }),
    'loc.act': (a) => {
      const f = ACT[a.action];
      if (!f) throw new ToolError(`Unknown locator action: ${oneLine(a.action, 40)}`, 'bad_args');
      return on(a.tab, READS_ONLY.has(a.action) ? 'read' : 'write', (tab) => f(tab, { ...a, options: a.options || {} }));
    },
    'loc.read': (a) => on(a.tab, 'read', (tab) => read(tab, a)),
    'loc.waitFor': (a) =>
      on(a.tab, 'read', (tab) => {
        const state = ['attached', 'detached', 'visible', 'hidden'].includes(a.state) ? a.state : 'visible';
        return until(tab, a, budget(a.timeoutMs), async (q) => {
          if (state === 'detached') return q.count ? { wait: 'to go away' } : { done: true };
          if (!q.count) return state === 'hidden' ? { done: true } : { wait: 'to appear (nothing matches yet)' };
          strict(q, a.desc);
          if (state === 'attached') return { done: true };
          const [s] = await tabs.inspect(tab, q.sessionId, q.refs, 'state');
          return !!s?.visible === (state === 'visible') ? { done: true } : { wait: `to be ${state}` };
        });
      }),
  };

  return async (op, args) => {
    const f = Object.hasOwn(OPS, op) ? OPS[op] : null;
    if (!f) throw new ToolError(`Unknown browser operation: ${oneLine(op, 60)}`, 'bad_args');
    checkLookOnly(ctx, op, args);
    try {
      return (await f(args)) ?? null;
    } catch (e) {
      // the host's own advice names browser_handle_dialog; in a script it is getJsDialog()
      if (e instanceof ToolError && e.code === 'dialog_open')
        throw new ToolError(
          `${e.message.replace(/ Answer it with browser_handle_dialog first\.$/, '')} Answer it first: const d = await tab.getJsDialog(); await d.accept() (or d.dismiss()).`,
          e.code,
        );
      throw e;
    }
  };
}

/**
 * The browser_script tool's handler body: runs the script and turns the outcome into content (text, the
 * screenshots, without browser_state), or a ToolError naming the failing line (with the state inside).
 * deps: { tabs, gate, act, navigate, confirmed, sessions } bound to this call's ctx; sessions: the chats'
 * ScriptSessions, whose session for this chat runs the code.
 */
async function browserScript(args, ctx, deps) {
  const code = String(args.code ?? '');
  if (!code.trim()) throw new ToolError('Give the script in code.', 'bad_args');
  if (code.length > CODE_MAX)
    throw new ToolError(`The script is too long (at most ${CODE_MAX.toLocaleString('en-US')} characters).`, 'bad_args');
  const timeoutMs = Math.max(1000, Math.min(MAX_MS, Math.round(Number(args.timeoutMs) || DEFAULT_MS)));
  const images = [];
  const dispatch = createScriptOps({ ...deps, ctx, images, deadline: Date.now() + timeoutMs });
  const current = deps.tabs.current(ctx.chatId);
  const r = await deps.sessions.get(ctx.chatId).run({ code, timeoutMs, signal: ctx.signal, current: current?.id ?? null, dispatch });
  lookRefusal(ctx);
  const reset = r.lost
    ? `\nNote: this call started a new script session, so variables from earlier browser_script calls are gone (${r.lost}).`
    : '';
  const console = r.logs.length
    ? `\nConsole:\n${r.logs.join('\n')}${r.dropped ? `\n[${r.dropped} more console line${r.dropped === 1 ? '' : 's'} dropped at the ${LOG_MAX.toLocaleString('en-US')}-character limit.]` : ''}`
    : '';
  if (!r.ok) {
    const e = r.error || { message: 'The script failed.' };
    const hint = hintOf(e);
    const lost = images.length
      ? `\n(${images.length} screenshot${images.length === 1 ? '' : 's'} taken before the failure ${images.length === 1 ? 'is' : 'are'} not returned.)`
      : '';
    throw new ToolError(
      `browser_script failed${lineOf(code, e)}\n${e.name && e.name !== 'Error' && e.name !== 'BrowserError' ? `${e.name}: ` : ''}${e.message}${hint ? `\nHint: ${hint}` : ''}${reset}${console}${lost}\n${deps.tabs.state(ctx.chatId)}`,
      failureCode(e),
    );
  }
  const result = withPagingNote(r.undef ? 'undefined' : capped(String(r.value), RESULT_MAX));
  /** @type {import('../contract/registry.cjs').ToolContent[]} */
  const content = [{ type: 'text', text: `Script finished in ${(r.ms / 1000).toFixed(1)} s.${reset}${console}\nResult: ${result}` }];
  images.forEach((shot, i) => {
    content.push({
      type: 'text',
      text: `Screenshot ${i + 1} (${shot.tab}, ${oneLine(shot.what, 120)}): image ${shot.width}x${shot.height}; coordinate frame ${shot.frame.w}x${shot.frame.h} CSS pixels${shot.truncated ? '; the page is taller and was cut at 8000 pixels' : ''}.`,
    });
    content.push({ type: 'image', data: shot.data, mimeType: 'image/jpeg', from: shot.url });
  });
  return content;
}

/** The worker's start-up data: what every script session gets. */
const SESSION_INIT = { platform: process.platform, doc: REFERENCE };

module.exports = {
  SCRIPT_SPEC: SPEC,
  SCRIPT_REFERENCE: REFERENCE,
  SESSION_INIT,
  browserScript,
  ScriptSession,
  ScriptSessions,
  createScriptOps,
  WORKER_SOURCE,
  DEFAULT_MS,
  MAX_MS,
  LOCATOR_MS,
  IMAGES_MAX,
  RESULT_MAX,
  LOG_MAX,
};
