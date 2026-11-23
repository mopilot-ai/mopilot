// Remote Control for Claude Code sessions: links a live CLI to the user's claude.ai account (claude.ai/code, the Claude app)
// through the Agent SDK's enableRemoteControl, and keeps the link across a CLI that ends and starts again (the idle reaper,
// an app restart) by remembering the bridge session it made and reattaching to it. The bridge needs a claude.ai subscription
// login that the organization allows; where it is unavailable the session says so instead of pretending.
const { clock } = require('../../platform/ports/clock.cjs');
const path = require('node:path');
const { AUTH, NETWORK, TRANSIENT, OFFLINE, RECONNECTING, UNAVAILABLE, isRecord, text, linkOf } = require('./remoteControlText.cjs');

/** How long a connect or disconnect gets before the session shows it failed; a late answer is still dealt with. */
const REQUEST_MS = 30_000;
/** The remembered choices kept, oldest first out. */
const MAX_CHOICES = 200;
/** How long a session waits for its user to sign in again before it gives up on the link (Claude Desktop waits as long). */
const SIGNIN_WAIT_MS = 24 * 60 * 60 * 1000;
/** Reconnects after the network went or a connect failed for a reason that passes: how long before each of the first tries. */
const RETRY_MS = [5_000, 15_000, 45_000, 60_000];
/** Between tries after those. */
const RETRY_SLOW_MS = 5 * 60_000;
/** How long a link that keeps failing for a reason that passes is retried before it is given up (the sign-in wait's day). */
const RECONNECT_WAIT_MS = 24 * 60 * 60 * 1000;
const TICK_MS = 15_000;
/** How often a sign-in that may have happened is tried. */
const SIGNIN_RETRY_MS = 60_000;
/** How long after a /clear the next new chat takes over the link of the chat it replaced. */
const CLEAR_WINDOW_MS = 2 * 60 * 1000;
/** The phases a session wants a link in, whether or not it is up right now. */
const LIVE = new Set(['on', 'connecting', 'offline', 'signin']);
/**
 * @param {{ emit: (event: object) => void, remoteFile?: any, remoteIo?: any, online?: () => boolean,
 *           onResume?: (fn: () => void) => (() => void) | undefined }} state
 * @param {{ lifetime: { active: (s: any) => boolean }, file?: string | null | (() => string | null),
 *           io?: { read: (file: string) => any, write: (file: string, text: string) => void },
 *           note: (what: string, error: unknown) => void, requestMs?: number, online?: () => boolean, now?: () => number,
 *           ticking?: boolean }} deps
 *   `file` keeps the remembered choices (null: in memory only), read and written through `io`; `note` records an error
 *   that is ignored on purpose; `online` says whether the network is up, and `ticking: false` leaves the periodic check to the caller
 */
function createRemoteControl(state, { lifetime, note, requestMs = REQUEST_MS, now = () => clock.now(), ticking = true, ...given }) {
  // where the choices live, how they are read and written, and whether the network is up: the state's, unless a test brings its own
  const { file: fileOf = state.remoteFile, io = state.remoteIo, online = state.online ?? (() => true) } = given;
  /** The store's file (resolved on first use, as userData is), or null for none. */
  const file = () => (typeof fileOf === 'function' ? fileOf() : fileOf);
  /** @type {{ connectNew: boolean, choices: Record<string, { on: boolean, bridge?: string, account?: string, waitSince?: number, lostSince?: number }> } | undefined} */
  let saved;
  function data() {
    if (!saved) {
      const f = file();
      const d = f ? io.read(f) : null;
      saved = { connectNew: d?.connectNew === true, choices: isRecord(d?.choices) ? { ...d.choices } : {} };
    }
    return saved;
  }
  function save() {
    const f = file();
    if (!f) return;
    try {
      io.write(f, JSON.stringify(data()));
    } catch (error) {
      // the choices still hold for this run
      note('save the Remote Control choices', error);
    }
  }
  /** Remember what the user chose for a session (a bridge to reattach to, or an explicit off). */
  function choose(sessionId, choice) {
    const d = data();
    delete d.choices[sessionId];
    if (choice) d.choices[sessionId] = choice;
    for (const old of Object.keys(d.choices).slice(0, Math.max(0, Object.keys(d.choices).length - MAX_CHOICES))) delete d.choices[old];
    save();
  }
  /** Only a session on disk that is not a side chat is remembered or linked on its own. */
  const durable = (s) => !!s.sessionId && !s.unpersisted && !s.keep && !s.isolated;

  const rcOf = (s) =>
    (s.rc ??= {
      phase: 'off',
      started: false,
      gen: 0,
      want: false,
      url: null,
      bridge: null,
      error: null,
      available: undefined,
      tries: 0,
      nextAt: 0,
      /** since when a link wanted has been failing for a reason that passes (the network, a timeout, a 5xx) */
      lostSince: null,
      signin: null,
    });
  /** Whether a session's link is wanted right now, up or on its way back: ending its CLI would drop it. */
  const holds = (s) => !!s?.rc?.want && LIVE.has(s.rc.phase);
  /** What is remembered of a session whose link is wanted: its bridge, the login it runs on, and since when it waits for a sign-in. */
  const remember = (s, r) =>
    durable(s) &&
    choose(s.sessionId, {
      on: true,
      ...(r.bridge ? { bridge: r.bridge } : {}),
      ...(s.account ? { account: s.account } : {}),
      ...(r.signin ? { waitSince: r.signin.since } : {}),
      ...(r.lostSince ? { lostSince: r.lostSince } : {}),
    });
  /** After a /clear: when, and whether the chat it replaced had a link, so the new chat takes it over. */
  let clearedAt = 0;

  // the sessions whose link is wanted, looked at every few seconds: the network going and coming back, a sign-in that may
  // have happened, and the retries after each. Without a signal from the CLI about its bridge, this is how they are known.
  const watched = new Set();
  let timer;
  /** Stops listening for the computer waking, while any link is watched. */
  let unlisten;
  let wasOnline = true;
  function watch(s) {
    watched.add(s);
    if (ticking && !timer) {
      timer = clock.setInterval(() => void tick(), TICK_MS);
      timer.unref?.();
      // a sleep is no tick: the network and the bridge come back at once, so a wait for the next try is cut short
      unlisten = state.onResume?.(() => void wake());
    }
  }
  function unwatch(s) {
    watched.delete(s);
    if (!watched.size && timer) {
      clock.clearInterval(timer);
      timer = undefined;
      unlisten?.();
      unlisten = undefined;
    }
  }
  /** What the window shows for a session. */
  function view(s) {
    const r = rcOf(s);
    return { state: r.phase, url: r.url, error: r.error, wanted: r.want };
  }
  /** Tell the chat; a window that can't hear it must not leave the link half-changed. */
  function emit(s) {
    try {
      state.emit({ key: s.key, kind: 'remoteControl', ...view(s) });
    } catch (error) {
      note('publish the state of a Remote Control link', error);
    }
  }
  function publish(s) {
    if (lifetime.active(s)) emit(s);
    return view(s);
  }
  /** Whether this login can have a bridge: the CLI says so in its init answer; a CLI that doesn't say is asked to connect. */
  async function allowed(s, r) {
    if (r.available === undefined) {
      try {
        const init = await s.q.initializationResult?.();
        r.available = !isRecord(init) || init.remote_control_available !== false;
      } catch (error) {
        note("read a Claude Code session's Remote Control availability", error);
        r.available = true;
      }
    }
    return r.available;
  }
  /** Take the bridge down on the CLI's side; the caller decides what that means for the session. */
  const drop = (s) => Promise.resolve().then(() => s.q.enableRemoteControl(false));
  const dropQuietly = (s) => drop(s).catch((error) => note('disconnect a Remote Control bridge that was not recorded', error));

  async function connect(s, r, gen, { title, reattach }) {
    if (!(await allowed(s, r))) {
      if (gen === r.gen && lifetime.active(s)) Object.assign(r, { phase: 'unavailable', want: false, error: UNAVAILABLE });
      return publish(s);
    }
    // a newer request (or the end of this process) took over while availability was read
    if (gen !== r.gen || !lifetime.active(s)) return view(s);
    Object.assign(r, { phase: 'connecting', want: true, error: null });
    publish(s);
    const call = Promise.resolve().then(() =>
      s.q.enableRemoteControl(true, title, { keepSessionOnExit: true, ...(reattach ? { reattachSessionId: reattach } : {}) }),
    );
    const late = Symbol('late');
    let timer;
    try {
      const answer = await Promise.race([call, new Promise((done) => (timer = clock.setTimeout(done, requestMs, late)))]);
      if (answer === late) {
        // it may still come up: a link nobody recorded is taken down, one a newer connect is recording is left to it
        call.then(
          (a) => {
            if (linkOf(a) && r.phase !== 'on' && r.phase !== 'connecting' && lifetime.active(s)) void dropQuietly(s);
          },
          (error) => note('settle a late Remote Control connect', error),
        );
        throw new Error('Remote Control did not connect in time');
      }
      const link = linkOf(answer);
      if (!link) throw new Error('Claude Code did not return a Remote Control link');
      if (!lifetime.active(s)) return view(s);
      if (gen !== r.gen) {
        // asked to turn off meanwhile: this link was never recorded, so it comes down; a newer connect records its own
        if (!r.want) void dropQuietly(s);
        return view(s);
      }
      Object.assign(r, { phase: 'on', url: link.url, bridge: link.bridge, error: null, tries: 0, lostSince: null, signin: null });
      remember(s, r);
      watch(s);
    } catch (error) {
      if (gen === r.gen && lifetime.active(s)) fail(s, r, error, reattach);
    } finally {
      clock.clearTimeout(timer);
    }
    return publish(s);
  }

  /** How long before try number `tries`: the first few climb, then one every few minutes. */
  const retryDelay = (tries) => (tries < RETRY_MS.length ? RETRY_MS[tries] : RETRY_SLOW_MS);

  /**
   * A connect that failed: a sign-in is waited for (up to a day, on the same login); the network, a timeout or a 5xx is
   * retried with a growing wait for up to a day; anything else is an error the user can retry from the switch.
   */
  function fail(s, r, error, reattach) {
    const message = text(error);
    const auth = AUTH.test(message) && !/did not (connect|disconnect) in time/.test(message);
    if (auth) {
      r.signin ??= { since: now(), account: s.account };
      Object.assign(r, {
        phase: 'signin',
        url: null,
        error: 'Sign in to Claude Code to reconnect Remote Control',
        nextAt: now() + SIGNIN_RETRY_MS,
      });
      remember(s, r);
      return watch(s);
    }
    const network = NETWORK.test(message) || !online();
    r.lostSince ??= now();
    if ((network || TRANSIENT.test(message)) && now() - r.lostSince <= RECONNECT_WAIT_MS) {
      // a reattach that fails with the network up may be to a bridge that is gone: the next try makes a new one
      if (reattach && !network) r.bridge = null;
      Object.assign(r, {
        phase: 'offline',
        url: null,
        error: network ? OFFLINE : RECONNECTING,
        nextAt: now() + retryDelay(r.tries),
      });
      remember(s, r);
      return watch(s);
    }
    unwatch(s);
    Object.assign(r, { phase: 'error', url: null, error: network ? "Couldn't reconnect Remote Control" : message });
  }

  /** One look at every watched session; exported so a test (or a wake from sleep) can ask for it now. */
  async function tick() {
    const t = now();
    // the network coming back ends the waiting: the first try is now, and the climb starts again
    const up = online();
    const back = up && !wasOnline;
    wasOnline = up;
    for (const s of [...watched]) {
      const r = s.rc;
      if (!lifetime.active(s) || !holds(s)) {
        unwatch(s);
        continue;
      }
      if (r.phase === 'on') {
        // the network went: the link is shown as waiting for it, and comes back with the network
        if (!up) {
          Object.assign(r, { phase: 'offline', error: OFFLINE, tries: 0, lostSince: t, nextAt: t });
          publish(s);
        }
        continue;
      }
      if (back && r.phase === 'offline') Object.assign(r, { tries: 0, nextAt: t });
      if (r.phase === 'connecting' || t < r.nextAt) continue;
      if (r.phase === 'offline' && !up) continue;
      if (r.phase === 'signin' && t - r.signin.since > SIGNIN_WAIT_MS) {
        unwatch(s);
        if (durable(s)) choose(s.sessionId, null);
        Object.assign(r, {
          phase: 'error',
          want: false,
          signin: null,
          error: 'Remote Control was not reconnected: no sign-in within a day',
        });
        publish(s);
        continue;
      }
      r.tries = r.phase === 'offline' ? r.tries + 1 : r.tries;
      await set(s, true, { reattach: r.bridge ?? data().choices[s.sessionId]?.bridge });
    }
  }

  /** The computer woke from sleep: a link waiting for its next try tries now, from the start of the climb. */
  function wake() {
    const t = now();
    for (const s of watched) if (s.rc?.phase === 'offline') Object.assign(s.rc, { tries: 0, nextAt: t });
    return tick();
  }

  async function disconnect(s, r, gen) {
    Object.assign(r, { want: false, signin: null });
    unwatch(s);
    try {
      let timer;
      await Promise.race([
        drop(s),
        new Promise((_, no) => (timer = clock.setTimeout(no, requestMs, new Error('Remote Control did not disconnect in time')))),
      ]).finally(() => clock.clearTimeout(timer));
    } catch (error) {
      // the link may still be up: the session keeps showing it and the caller hears why
      if (gen === r.gen && lifetime.active(s)) {
        r.error = text(error);
        // it may still be up: it is watched again
        r.want = true;
        watch(s);
      }
      publish(s);
      throw error;
    }
    // the link is down, and the off is remembered, so neither a restart nor the connect-new-sessions setting links it again
    if (durable(s)) choose(s.sessionId, { on: false });
    if (gen === r.gen && lifetime.active(s)) Object.assign(r, { phase: 'off', url: null, bridge: null, error: null, lostSince: null });
    return publish(s);
  }

  /**
   * Turn Remote Control on or off for a live session; the newest request wins and an older one's answer changes nothing
   * but taking down a link nobody recorded. Resolves the session's view (a failed connect is a view with state 'error').
   * @param {any} s the live session
   * @param {boolean} on
   * @param {{ title?: string, reattach?: string }} [o]
   */
  function set(s, on, o = {}) {
    const r = rcOf(s);
    // already linked: nothing to ask of the CLI (a reattach after a restart is a different request)
    if (on && r.phase === 'on' && r.want && !o.reattach) return Promise.resolve(view(s));
    // a connect already under way answers this one too: asking again would make a second bridge
    if (on && r.connecting && !o.reattach) return r.pending;
    const gen = ++r.gen;
    if (on) r.want = true;
    // a fresh ask is not a continuation of a wait that is over
    if (on && r.phase === 'error') r.lostSince = null;
    const run = on
      ? connect(s, r, gen, { title: o.title || path.basename(s.cwd || '') || 'MoPilot', reattach: o.reattach })
      : disconnect(s, r, gen);
    r.pending = run;
    r.connecting = on;
    const done = () => void (r.pending === run && (r.connecting = false));
    if (on) void run.then(done, done);
    return run;
  }

  /** A CLI that just started: reconnect what the user had on (reattaching to its bridge), or link a new session when the setting says so. */
  function onStart(s, { fresh }) {
    // the CLI's init comes once per process; a repeat is not a new start
    if (rcOf(s).started || !durable(s)) return;
    rcOf(s).started = true;
    const choice = data().choices[s.sessionId];
    const inherit = fresh && clearedAt > 0 && now() - clearedAt < CLEAR_WINDOW_MS;
    if (inherit) clearedAt = 0;
    if (choice?.on === false || (!choice && !(data().connectNew && fresh) && !inherit)) return;
    // a link wanted on another login is not made on this one; one that waited a day for a sign-in is given up
    if (choice?.account && s.account && choice.account !== s.account) return;
    if (choice?.waitSince && now() - choice.waitSince > SIGNIN_WAIT_MS) return void choose(s.sessionId, null);
    if (choice?.waitSince) rcOf(s).signin = { since: choice.waitSince, account: choice.account };
    if (choice?.lostSince) rcOf(s).lostSince = choice.lostSince;
    reattach(s, choice?.bridge, 'reconnect Remote Control for a new Claude Code process');
  }

  /** Link a session again on its bridge, or on a new one when that bridge is refused for a reason that does not pass. */
  function reattach(s, bridge, what) {
    set(s, true, bridge ? { reattach: bridge } : {})
      .then((v) => (v.state === 'error' && bridge ? set(s, true) : v))
      .catch(note.bind(null, what)); // set resolves a view even when the connect fails; this is for a bug, not an answer
  }

  /**
   * The CLI took its bridge down on purpose (a `worker_shutting_down` message, sent only on a graceful teardown) while the
   * link was up and wanted. Someone turned it off (`remote_control_disabled`: the CLI's own command, managed settings): it is
   * off here too, and stays off after a restart. The CLI is exiting (`host_exit`): its end answers for it, and the saved bridge
   * is reattached at the next start. Anything else: the link is shown as reconnecting and reattached at once.
   * A link that is not up is left alone (a connect under way answers for itself).
   * @param {any} s
   * @param {string} [reason]
   */
  function onWorkerShutdown(s, reason) {
    const r = s.rc;
    if (!r || r.phase !== 'on' || !r.want || !lifetime.active(s) || reason === 'host_exit') return;
    unwatch(s);
    if (reason === 'remote_control_disabled') {
      r.gen++;
      Object.assign(r, { phase: 'off', want: false, url: null, bridge: null, error: null, lostSince: null });
      if (durable(s)) choose(s.sessionId, { on: false });
      publish(s);
      return;
    }
    const t = now();
    Object.assign(r, { phase: 'offline', error: RECONNECTING, tries: 0, lostSince: t, nextAt: t });
    watch(s);
    publish(s);
    reattach(s, r.bridge, 'reattach a Remote Control bridge the CLI took down');
  }

  /** What the CLI said that Remote Control cares about: its start (`init`, `fresh`: a new chat) and a bridge it took down (`worker_shutting_down`). */
  function onMessage(s, msg, fresh) {
    if (msg.type !== 'system') return;
    if (msg.subtype === 'init') onStart(s, { fresh });
    else if (msg.subtype === 'worker_shutting_down') onWorkerShutdown(s, msg.reason);
  }

  /** The CLI ended: the link went with it (a remembered one is reattached by the next process). */
  function onEnd(s) {
    const r = s.rc;
    unwatch(s);
    if (!r || r.phase === 'off') return;
    r.gen++;
    Object.assign(r, { phase: 'off', url: null, bridge: null, error: null, lostSince: null });
    emit(s);
  }

  /**
   * A chat archived or deleted: its link comes down now and is forgotten, so neither a restart nor opening the chat again
   * links it, and nothing stays steerable from claude.ai. Quitting the app is not this: a link left up at quit keeps its saved
   * bridge, which the next run reattaches. Null when no link is up (nothing to wait for), else a promise that never rejects (a
   * bridge that won't drop is noted; the CLI's end takes it down).
   * @param {string | null | undefined} sessionId
   * @param {any} [s] the chat's live session, if it has one
   * @param {{ cleared?: boolean }} [o] `cleared`: a /clear started a new chat, which takes over the link this chat had
   */
  function release(sessionId, s, o = {}) {
    if (o.cleared && (s?.rc?.want || (sessionId && data().choices[sessionId]?.on))) clearedAt = now();
    if (sessionId) choose(sessionId, null);
    const r = s?.rc;
    if (s) unwatch(s);
    if (!r || !lifetime.active(s) || !LIVE.has(r.phase)) return null;
    r.gen++;
    Object.assign(r, { want: false, signin: null });
    return drop(s)
      .catch((error) => note('disconnect the Remote Control of an archived or deleted chat', error))
      .then(() => {
        if (lifetime.active(s)) Object.assign(r, { phase: 'off', url: null, bridge: null, error: null, lostSince: null });
        publish(s);
      });
  }

  /** claude:remoteControlDefault / claude:setRemoteControlDefault: the Settings switch. */
  function registerIpc(ipcMain) {
    ipcMain.handle('claude:remoteControlDefault', () => data().connectNew);
    ipcMain.handle('claude:setRemoteControlDefault', (_e, on) => {
      data().connectNew = on === true;
      save();
      return data().connectNew;
    });
  }

  return {
    registerIpc,
    release,
    set,
    tick,
    wake,
    holds,
    view,
    onStart,
    onMessage,
    onEnd,
  };
}

module.exports = {
  createRemoteControl,
  linkOf,
  REQUEST_MS,
  SIGNIN_WAIT_MS,
  RETRY_MS,
  RETRY_SLOW_MS,
  RECONNECT_WAIT_MS,
  CLEAR_WINDOW_MS,
  UNAVAILABLE,
};
