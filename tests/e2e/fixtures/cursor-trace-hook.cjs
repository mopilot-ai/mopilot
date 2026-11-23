// Main-process hook (electron -r) that traces the phantom cursor overlay: what main asked of it, when its window showed and hid, and the cursor's position and opacity as the page really renders them (sampled over the DevTools protocol, since the page runs no script). Read it with globalThis.__cursorTrace.
if (process.type === 'browser') {
  const { PhantomCursor } = require('../../../electron/capabilities/phantomCursor.cjs');
  const now = () => performance.timeOrigin + performance.now();
  /** events: what main did; samples: the page as drawn; reduced: pretend the system asks for Reduce Motion */
  const trace = (globalThis.__cursorTrace = { events: [], samples: [], reduced: false, mode: null, errors: [] });
  const note = (ev, extra) => trace.events.push({ t: now(), ev, ...extra });
  const P = PhantomCursor.prototype;
  const wrap = (name, before) => {
    const orig = P[name];
    P[name] = function (...args) {
      before?.call(this, ...args);
      return orig.apply(this, args);
    };
  };
  wrap('finish', (a) => note('finish', { confirmed: !!a?.confirmed }));
  wrap('cancel', () => note('cancel'));
  wrap('hide', () => note('hide'));
  const approach = P.approach;
  P.approach = function (a) {
    // a CI runner's session may ask for Reduce Motion: the timeline is measured with it off unless the spec turns it on
    if (!('system' in trace)) {
      try {
        trace.system = require('electron').systemPreferences.getAnimationSettings();
      } catch (error) {
        trace.system = { error: error.message };
      }
    }
    this.reducedMotion = () => trace.reduced;
    const to = a?.points?.[a.points.length - 1];
    note('approach', { kind: a?.kind, to, bounds: a?.bounds });
    const done = approach.call(this, a);
    if (this.window) instrument(this.window);
    return done;
  };

  // The expression the page answers: the cursor's tip (the arrow's point is 2,2 into its 22 px box) and the opacity of what shows.
  const EXPR = `(() => {
    const q = (s) => document.querySelector(s);
    const op = (e) => (e ? parseFloat(getComputedStyle(e).opacity) : 0);
    const c = q('.cur');
    const b = c && c.getBoundingClientRect();
    // every animation frame the page draws, if its timers run at all with script off (each poll hands over the frames since the last)
    if (!window.__r) {
      window.__r = [];
      const tick = () => {
        const cur = q('.cur');
        const r = cur && cur.getBoundingClientRect();
        window.__r.push([performance.timeOrigin + performance.now(), r ? r.left + 2 : null, r ? r.top + 2 : null, op(cur), op(q('.arrow')), op(q('.disc'))]);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
    const frames = window.__r.splice(0);
    const anims = document.getAnimations().map((a) => ({ n: a.animationName, st: a.startTime, d: a.effect.getTiming().duration, ps: a.playState }));
    return { frames, pa: performance.timeOrigin + performance.now(), org: performance.timeOrigin, anims, page: c ? 'cursor' : q('.ripple') ? 'ring' : 'blank', x: b ? b.left + 2 : null, y: b ? b.top + 2 : null, cur: op(c), arrow: op(q('.arrow')), disc: op(q('.disc')) };
  })()`;

  const seen = new WeakSet();
  function instrument(w) {
    if (seen.has(w)) return;
    seen.add(w);
    for (const name of ['showInactive', 'hide']) {
      const orig = w[name].bind(w);
      w[name] = (...args) => {
        note(name);
        return orig(...args);
      };
    }
    const load = w.loadURL.bind(w);
    w.loadURL = (url, ...rest) => {
      note('load', {
        glide: decodeURIComponent(url).includes('@keyframes glide'),
        page: url.includes('class%3D%22ripple%22') ? 'ring' : url.includes('class%3D%22cur%22') ? 'cursor' : 'other',
      });
      return load(url, ...rest);
    };
    try {
      w.webContents.debugger.attach('1.3');
    } catch (error) {
      trace.errors.push(`attach: ${error.message}`);
      return;
    }
    void sampleLoop(w);
  }

  /** The cursor through the DOM domain, when the page cannot be asked with script. */
  async function sampleDom(dbg) {
    const doc = await dbg.sendCommand('DOM.getDocument', { depth: 0 });
    const find = async (selector) => (await dbg.sendCommand('DOM.querySelector', { nodeId: doc.root.nodeId, selector })).nodeId;
    const opacity = async (nodeId) => {
      if (!nodeId) return 0;
      const { computedStyle } = await dbg.sendCommand('CSS.getComputedStyleForNode', { nodeId });
      return parseFloat(computedStyle.find((p) => p.name === 'opacity')?.value ?? '1');
    };
    const cur = await find('.cur');
    if (!cur) return { page: (await find('.ripple')) ? 'ring' : 'blank', x: null, y: null, cur: 0, arrow: 0, disc: 0 };
    const { model } = await dbg.sendCommand('DOM.getBoxModel', { nodeId: cur });
    return {
      page: 'cursor',
      x: model.border[0] + 2,
      y: model.border[1] + 2,
      cur: await opacity(cur),
      arrow: await opacity(await find('.arrow')),
      disc: await opacity(await find('.disc')),
    };
  }

  async function sampleLoop(w) {
    const dbg = w.webContents.debugger;
    let mode = 'eval';
    let wasVisible = false;
    const sleep = () => new Promise((resolve) => setTimeout(resolve, 1));
    while (!w.isDestroyed() && trace.samples.length < 400000) {
      const vis = w.isVisible();
      if (!vis) {
        if (wasVisible) trace.samples.push({ t: now(), vis: false, page: 'hidden', x: null, y: null, cur: 0, arrow: 0, disc: 0 });
        wasVisible = false;
        await sleep();
        continue;
      }
      wasVisible = true;
      const t0 = now();
      try {
        let s;
        if (mode === 'eval') {
          const r = await dbg.sendCommand('Runtime.evaluate', { expression: EXPR, returnByValue: true });
          if (r.exceptionDetails || !r.result?.value) throw new Error(r.exceptionDetails?.text ?? 'no value');
          s = r.result.value;
        } else s = await sampleDom(dbg);
        const { frames = [], ...rest } = s;
        for (const [t, x, y, cur, arrow, disc] of frames)
          trace.samples.push({ t, vis: true, page: x == null ? 'blank' : 'cursor', x, y, cur, arrow, disc, frame: true });
        trace.samples.push({ t: rest.pa ?? (t0 + now()) / 2, t0, vis: true, ...rest });
        trace.mode ??= mode;
      } catch (error) {
        // a page that is replaced mid-call answers 'navigated or closed': that is a load, not a page that cannot be asked with script
        if (/navigated or closed/.test(error.message)) {
          if (trace.errors.length < 50) trace.errors.push(`${mode}: ${error.message}`);
        } else if (mode === 'eval' && trace.mode === null) {
          trace.errors.push(`eval: ${error.message}; using the DOM domain`);
          mode = 'dom';
          try {
            await dbg.sendCommand('DOM.enable');
            await dbg.sendCommand('CSS.enable');
          } catch (e) {
            trace.errors.push(`dom enable: ${e.message}`);
          }
        } else if (trace.errors.length < 50) trace.errors.push(`${mode}: ${error.message}`);
      }
      await sleep();
    }
  }
}
