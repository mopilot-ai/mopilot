// Relays the tool calls of Host-resident harnesses to the paired app. The app announces its tools (`host.toolsSync`); each becomes a tool of the Host's registry whose handler sends the call to the connection that owns the chat (`{ event: 'tool' }`) and waits for `host.toolResult`. The app runs the call (approvals, site permission and per-Host routing are its own), so the Host asks nobody itself. A call never hangs: no app for the chat, an app that goes away, a Stop, the harness cancelling and a missing answer all end it with a structured refusal, and the app is told to stop (`{ event: 'toolCancel' }`).
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const { ToolError } = createRequire(import.meta.url)('../../electron/capabilities/contract/registry.cjs');

/** How long a call waits for the app: well beyond a person answering an approval card. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * @typedef {{ name: string, description: string, inputSchema: object, policy: 'observe' | 'act' | 'irreversible' }} ToolSpec
 * @typedef {{ emit: (message: object) => void, epochOf: (chatId: string) => number, specs: Map<string, ToolSpec>, identity: () => string | null }} Conn one connected app
 * @typedef {{ conn: Conn, chatId: string, settle: (done: () => unknown) => void }} Pending a call waiting for the app
 */

/**
 * @param {object} o
 * @param {InstanceType<typeof import('../../electron/capabilities/contract/registry.cjs').Registry>} o.registry the Host's registry
 * @param {number} [o.timeoutMs] @param {() => string} [o.newId]
 * @param {Pick<ReturnType<typeof import('./callIntents.mjs').createCallIntents>, 'begin' | 'end'>} [o.intents] where a call that acts is written before it is sent, so a Host that dies leaves it for the next one to settle
 * @param {{ note: (e: any) => void }} [o.audit] where each relayed call's outcome is noted (the tool's name and whether it ran: never its arguments or result)
 * @param {typeof setTimeout} [o.setTimer] @param {typeof clearTimeout} [o.clearTimer] the call's timeout timer, replaceable so a test decides when it fires
 */
export function createToolRelay({
  registry,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  newId = randomUUID,
  intents,
  audit,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  /** @type {Set<Conn>} */
  const conns = new Set();
  /** The connection a chat's calls go to: among those that announced tools, the one that last sent to it (a subscribe only fills an empty seat). @type {Map<string, Conn>} */
  const owners = new Map();
  /** The connections subscribed to a chat, each with when it last watched or sent (a higher number is more recent): the fallbacks when the owner goes. @type {Map<string, Map<Conn, number>>} */
  const watchers = new Map();
  /** A chat whose owner went with no fallback: whose it was (the connection identity), so the same app's next `host.toolsSync` takes it back. @type {Map<string, string | null>} */
  const orphans = new Map();
  let clock = 0;
  /** @type {Map<string, Pending>} */
  const pending = new Map();
  /** The proxy tools in the registry, by name, with the spec they were made from. @type {Map<string, { spec: ToolSpec, unregister: () => void }>} */
  const proxies = new Map();

  /** The first connection to announce a name decides its spec. */
  function wanted() {
    /** @type {Map<string, ToolSpec>} */
    const all = new Map();
    for (const c of conns) for (const [name, spec] of c.specs) if (!all.has(name)) all.set(name, spec);
    return all;
  }

  /** Make the registry's proxy tools the union of what the connected apps announced. @returns {{ registered: string[], skipped: string[] }} */
  function reconcile() {
    const all = wanted();
    for (const [name, p] of proxies) {
      if (all.has(name) && JSON.stringify(all.get(name)) === JSON.stringify(p.spec)) continue;
      p.unregister();
      proxies.delete(name);
    }
    /** @type {string[]} */
    const skipped = [];
    for (const [name, spec] of all) {
      if (proxies.has(name)) continue;
      // a tool the Host has of its own is never replaced by an app's
      if (registry.has(name)) {
        skipped.push(name);
        continue;
      }
      const unregister = registry.register({
        name,
        description: spec.description,
        schema: spec.inputSchema,
        policy: spec.policy,
        // the app runs its own policy and cards: the Host has nobody to ask
        authorizesItself: true,
        handler: (/** @type {any} */ args, /** @type {{ chatId: string, segmentId: string, signal: AbortSignal }} */ ctx) =>
          call(name, args, ctx),
      });
      proxies.set(name, { spec, unregister });
    }
    return { registered: [...proxies.keys()], skipped };
  }

  /** Whether a connection may own calls: it announced at least one tool (a phone never does). @param {Conn} conn */
  const canOwn = (conn) => conns.has(conn) && conn.specs.size > 0;

  /** A connection watched or sent to a chat just now. @param {string} chatId @param {Conn} conn */
  function touch(chatId, conn) {
    const w = watchers.get(chatId) ?? new Map();
    watchers.set(chatId, w);
    w.set(conn, ++clock);
  }

  /** Give a chat with no live owner to its most recent watcher that can own, or leave it ownerless. @param {string} chatId */
  function reseat(chatId) {
    /** @type {Conn | null} */
    let best = null;
    let at = -1;
    for (const [c, t] of /** @type {Map<Conn, number>} */ (watchers.get(chatId))) if (canOwn(c) && t > at) (best = c), (at = t);
    if (best) owners.set(chatId, best);
    else owners.delete(chatId);
  }

  /** One call to the app that owns the chat. @returns {Promise<{ content: object[], endsTurn?: true }>} */
  async function call(
    /** @type {string} */ name,
    /** @type {any} */ args,
    /** @type {{ chatId: string, segmentId: string, signal: AbortSignal }} */ ctx,
  ) {
    const conn = owners.get(ctx.chatId);
    if (!conn || !conns.has(conn))
      throw new ToolError('The MoPilot app that started this chat is not connected, so this tool did not run.', 'app_offline');
    const callId = newId();
    const epoch = conn.epochOf(ctx.chatId);
    return new Promise((resolve, reject) => {
      /** @param {() => unknown} done */
      const settle = (done) => {
        pending.delete(callId);
        intents?.end(callId);
        clearTimer(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        try {
          resolve(/** @type {any} */ (done()));
          audit?.note({ kind: 'tool.relayed', chat: ctx.chatId, what: { tool: name, outcome: 'ok' } });
        } catch (e) {
          audit?.note({
            kind: 'tool.relayed',
            chat: ctx.chatId,
            what: { tool: name, outcome: 'refused', code: /** @type {any} */ (e)?.code },
          });
          reject(e);
        }
      };
      /** The app is told to stop what it is doing for this call, and the call ends. @param {InstanceType<typeof ToolError>} why */
      const stop = (why) => {
        send(conn, { event: 'toolCancel', chatId: ctx.chatId, epoch, callId });
        settle(() => {
          throw why;
        });
      };
      const onAbort = () => stop(new ToolError(String(ctx.signal.reason), 'aborted'));
      const timer = setTimer(() => stop(new ToolError('The MoPilot app did not answer in time.', 'timeout')), timeoutMs);
      timer.unref();
      pending.set(callId, { conn, chatId: ctx.chatId, settle });
      // a call that only looks changes nothing, so losing it loses nothing
      if (proxies.get(name)?.spec.policy !== 'observe') intents?.begin(callId, { chatId: ctx.chatId, kind: 'tool', name });
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      if (
        !send(conn, {
          event: 'tool',
          chatId: ctx.chatId,
          epoch,
          segmentId: ctx.segmentId,
          callId,
          name,
          arguments: args,
        })
      )
        settle(() => {
          throw new ToolError('The MoPilot app could not be reached, so this tool did not run.', 'app_offline');
        });
    });
  }

  /** @returns {boolean} whether the message was handed to the connection */
  function send(/** @type {Conn} */ conn, /** @type {object} */ message) {
    try {
      conn.emit(message);
      return true;
    } catch {
      return false;
    }
  }

  return {
    /** A tool call is waiting for the app's answer. */
    get pending() {
      return pending.size;
    },
    /** The harness of this chat was stopped: its calls end, and the app is told to stop them. @param {string} chatId */
    abortChat(chatId) {
      registry.abortChat(chatId, 'stopped');
    },
    /**
     * One connected app. `emit` writes a message to it; `epochOf` is a chat's current epoch, which the events carry and the answers must echo.
     * @param {(message: object) => void} emit @param {(chatId: string) => number} epochOf @param {() => string | null} [identity] the connection's trusted identity
     */
    attach(emit, epochOf, identity = () => null) {
      /** @type {Conn} */
      const conn = { emit, epochOf, specs: new Map(), identity };
      conns.add(conn);
      return {
        /** Replace the tools this app announces. @param {ToolSpec[]} tools */
        sync(tools) {
          conn.specs = new Map(tools.map((t) => [t.name, t]));
          for (const [chatId, c] of [...owners]) if (c === conn && !canOwn(conn)) reseat(chatId);
          if (canOwn(conn)) {
            // chats it watches that have nobody, and chats this same app owned before its connection dropped
            for (const [chatId, w] of watchers) if (w.has(conn) && !owners.has(chatId)) owners.set(chatId, conn);
            for (const [chatId, who] of [...orphans])
              if (who === conn.identity()) {
                orphans.delete(chatId);
                touch(chatId, conn);
                if (!owners.has(chatId)) owners.set(chatId, conn);
              }
          }
          return reconcile();
        },
        /** This app sent to the chat (`chat.start`, `chat.send`; its epoch checks passed): if it announced tools, the chat's calls go to it from now on. @param {string} chatId */
        send(chatId) {
          this.watch(chatId, true);
        },
        /** This app subscribed to the chat (its epoch checks passed): it can own it only when nobody does. @param {string} chatId @param {boolean} [sent] */
        watch(chatId, sent = false) {
          touch(chatId, conn);
          orphans.delete(chatId);
          if (canOwn(conn) && (sent || !owners.has(chatId))) owners.set(chatId, conn);
        },
        /**
         * The app's answer to a call. A call that already ended (answered, stopped, timed out) is acknowledged as not accepted; an answer from an app
         * the call was not sent to is refused.
         * @param {{ chatId: string, callId: string, ok: boolean, content: object[], endsTurn?: true, error?: { code: string, message: string } }} r
         */
        result(r) {
          const p = pending.get(r.callId);
          if (!p) return { accepted: false };
          if (p.conn !== conn || p.chatId !== r.chatId)
            throw Object.assign(new Error('That tool call was not sent to this app.'), { code: 'not_owned' });
          p.settle(() => {
            // the parser gives a failed result its error
            if (!r.ok) throw new ToolError(/** @type {any} */ (r.error).message, /** @type {any} */ (r.error).code);
            return r.endsTurn ? { content: r.content, endsTurn: true } : { content: r.content };
          });
          return { accepted: true };
        },
        /** The app went away: its calls end, its tools and chats are no longer served. */
        detach() {
          conns.delete(conn);
          for (const w of watchers.values()) w.delete(conn);
          // calls in flight end below; the next call goes to a fallback, if there is one
          for (const [chatId, c] of [...owners])
            if (c === conn) {
              reseat(chatId);
              if (!owners.has(chatId)) orphans.set(chatId, conn.identity());
            }
          for (const p of [...pending.values()])
            if (p.conn === conn)
              p.settle(() => {
                throw new ToolError('The MoPilot app disconnected before this tool finished.', 'app_offline');
              });
          reconcile();
        },
      };
    },
  };
}
