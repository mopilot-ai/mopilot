// The benchmark fakes' protocol rewriting: replaces a reply's text deltas, as the e2e fake harness sends them, with the benchmark's reply at its rate, and holds the stream's later messages until it has played (Codex app-server, Claude Code stream-json, ACP).
import { randomUUID } from 'node:crypto';
import { MARK } from './replay.mjs';

/** The key that arms a process's only stream (Claude Code runs one session per process). */
export const ANY_KEY = '*';

/**
 * Whether a prompt is one the runner typed: a string, or a list of text blocks or input items, one of which starts with
 * the bench marker. MoPilot's own queries (a chat's title, a model probe) start with their instructions.
 */
export function marked(/** @type {unknown} */ content) {
  if (typeof content === 'string') return content.startsWith(MARK);
  return Array.isArray(content) && content.some((b) => typeof b?.text === 'string' && b.text.startsWith(MARK));
}

/**
 * @typedef {{ key: string, held: any[], text: string, done: boolean, run: { done: Promise<void>, cancel: () => void } | null } & Record<string, any>} Stream
 * @typedef {{
 *   delta(msg: any): { key: string, init: Record<string, any> } | null,
 *   same(msg: any, st: Stream): boolean,
 *   belongs(msg: any, st: Stream, prompts: Map<unknown, string>): boolean,
 *   makeDelta(st: Stream, text: string): any,
 *   tools?(st: Stream, n: number): any[],
 *   rewrite(msg: any, st: Stream): any,
 *   ends(msg: any, st: Stream, prompts: Map<unknown, string>): boolean,
 *   client(msg: any, c: { cancel: (key: string) => void, cancelAll: () => void, prompts: Map<unknown, string> }): void,
 *   armed(msg: any): { key: string, marked: boolean } | null,
 * }} Protocol
 *   armed: for a message MoPilot sends that starts a turn, its stream key (ANY_KEY: the process's one session) and
 *   whether the user typed it with the bench marker (its reply is replayed); null for anything else
 */

/** Codex app-server JSON-RPC: a stream is a thread's reply item; its turn/completed ends it. */
export const codex = /** @type {Protocol} */ ({
  delta: (msg) =>
    msg.method === 'item/agentMessage/delta' && typeof msg.params?.threadId === 'string'
      ? { key: msg.params.threadId, init: { turnId: msg.params.turnId, itemId: msg.params.itemId } }
      : null,
  same: (msg, st) => msg.method === 'item/agentMessage/delta' && msg.params?.itemId === st.itemId,
  belongs: (msg, st) => msg.method !== undefined && msg.params?.threadId === st.key,
  makeDelta: (st, text) => ({
    method: 'item/agentMessage/delta',
    params: { threadId: st.key, turnId: st.turnId, itemId: st.itemId, delta: text },
  }),
  rewrite(msg, st) {
    const fix = (/** @type {any} */ item) => (item?.id === st.itemId ? { ...item, text: st.text } : item);
    if (msg.method === 'item/completed') return { ...msg, params: { ...msg.params, item: fix(msg.params.item) } };
    if (msg.method === 'turn/completed' && Array.isArray(msg.params?.turn?.items))
      return { ...msg, params: { ...msg.params, turn: { ...msg.params.turn, items: msg.params.turn.items.map(fix) } } };
    return msg;
  },
  ends: (msg) => msg.method === 'turn/completed',
  client(msg, c) {
    if (msg.method === 'turn/interrupt' && typeof msg.params?.threadId === 'string') c.cancel(msg.params.threadId);
  },
  armed: (msg) => (msg.method === 'turn/start' ? { key: String(msg.params?.threadId), marked: marked(msg.params?.input) } : null),
});

/** Claude Code's own messages, which never belong to a reply's order. */
const CLAUDE_CONTROL = new Set(['control_request', 'control_response', 'control_cancel_request', 'keep_alive']);

/** Claude Code stream-json: one session per process; a stream is a text block of the reply, its result ends it. */
export const claude = /** @type {Protocol} */ ({
  delta: (msg) =>
    msg.type === 'stream_event' && msg.event?.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta'
      ? { key: String(msg.session_id ?? ''), init: { index: msg.event.index } }
      : null,
  same: (msg, st) => msg.type === 'stream_event' && msg.event?.type === 'content_block_delta' && msg.event.index === st.index,
  belongs: (msg) => typeof msg.type === 'string' && !CLAUDE_CONTROL.has(msg.type),
  makeDelta: (st, text) => ({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: st.index, delta: { type: 'text_delta', text } },
    parent_tool_use_id: null,
    session_id: st.key,
    uuid: randomUUID(),
  }),
  rewrite(msg, st) {
    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      let replaced = false;
      const content = msg.message.content.map((/** @type {any} */ b) => {
        if (replaced || b?.type !== 'text') return b;
        replaced = true;
        return { ...b, text: st.text };
      });
      return { ...msg, message: { ...msg.message, content } };
    }
    if (msg.type === 'result' && typeof msg.result === 'string') return { ...msg, result: st.text };
    return msg;
  },
  ends: (msg) => msg.type === 'result',
  client(msg, c) {
    if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') c.cancelAll();
  },
  armed: (msg) => (msg.type === 'user' ? { key: ANY_KEY, marked: marked(msg.message?.content) } : null),
});

/** The answer to one of the client's requests (no method). */
const isResponse = (/** @type {any} */ msg) => msg.method === undefined && msg.id !== undefined;

/** ACP v1: a stream is a session's prompt; the answer to session/prompt ends it. */
export const acp = /** @type {Protocol} */ ({
  delta: (msg) =>
    msg.method === 'session/update' &&
    msg.params?.update?.sessionUpdate === 'agent_message_chunk' &&
    msg.params.update.content?.type === 'text' &&
    typeof msg.params.sessionId === 'string'
      ? { key: msg.params.sessionId, init: {} }
      : null,
  same: (msg, st) =>
    msg.method === 'session/update' && msg.params?.update?.sessionUpdate === 'agent_message_chunk' && msg.params.sessionId === st.key,
  belongs: (msg, st, prompts) => msg.params?.sessionId === st.key || (isResponse(msg) && prompts.get(msg.id) === st.key),
  makeDelta: (st, text) => ({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: st.key, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  }),
  tools(st, n) {
    const toolCallId = `bench-tool-${n}`;
    const update = (/** @type {object} */ u) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: st.key, update: u } });
    return [
      update({ sessionUpdate: 'tool_call', toolCallId, title: `Read notes-${n}.md`, kind: 'read', status: 'in_progress' }),
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: `notes ${n}` } }],
      }),
    ];
  },
  rewrite: (msg) => msg,
  ends(msg, st, prompts) {
    if (!isResponse(msg) || prompts.get(msg.id) !== st.key) return false;
    prompts.delete(msg.id);
    return true;
  },
  client(msg, c) {
    if (msg.method === 'session/prompt' && msg.id !== undefined) c.prompts.set(msg.id, msg.params?.sessionId);
    if (msg.method === 'session/cancel' && typeof msg.params?.sessionId === 'string') c.cancel(msg.params.sessionId);
  },
  armed: (msg) => (msg.method === 'session/prompt' ? { key: String(msg.params?.sessionId), marked: marked(msg.params?.prompt) } : null),
});

export const PROTOCOLS = Object.freeze({ codex, claude, acp });

/**
 * A rewriter for one fake process.
 * @param {{ protocol: Protocol, settings: () => import('./replay.mjs').Settings, out: (line: string) => void,
 *           player: (s: { text: string, rate: number, chunk: number, toolEveryMs?: number, gate?: boolean },
 *                    on: { onChunk: (t: string) => void, onTool: (n: number) => void }) => { done: Promise<void>, cancel: () => void },
 *           reply: (bytes: number) => string, log: (event: Record<string, unknown>) => void }} o
 *   settings: read when a reply starts; player: replay.mjs play (with its gate); log: turn start and end events for the runner
 */
export function createRewriter({ protocol: p, settings, out, player, reply, log }) {
  /** @type {Map<string, Stream>} */
  const streams = new Map();
  /** ACP: session/prompt request id → session */
  /** @type {Map<unknown, string>} */
  const prompts = new Map();
  /** @type {Set<Promise<void>>} */
  const playing = new Set();
  /** Streams whose next reply is replayed: a turn the runner sent */
  /** @type {Set<string>} */
  const armed = new Set();

  const write = (/** @type {any} */ msg) => out(JSON.stringify(msg));
  function emit(/** @type {any} */ msg, /** @type {Stream} */ st) {
    write(p.rewrite(msg, st));
    if (p.ends(msg, st, prompts) && streams.get(st.key) === st) streams.delete(st.key);
  }
  function start(/** @type {string} */ key, /** @type {Record<string, any>} */ init, /** @type {any} */ s) {
    /** @type {Stream} */
    const st = { ...init, key, held: [], text: '', done: false, run: null };
    streams.set(key, st);
    const text = s.text ?? reply(s.bytes);
    const run = player(
      { text, rate: s.rate, chunk: s.chunk, toolEveryMs: s.toolEveryMs, gate: s.gate },
      {
        onChunk(t) {
          if (st.text === '') log({ kind: 'start', key });
          st.text += t;
          write(p.makeDelta(st, t));
        },
        onTool: (n) => {
          for (const m of p.tools?.(st, n) ?? []) write(m);
        },
      },
    );
    st.run = run;
    const finished = run.done.then(() => {
      st.done = true;
      log({ kind: 'end', key, chars: st.text.length });
      const held = st.held;
      st.held = [];
      for (const m of held) emit(m, st);
    });
    playing.add(finished);
    void finished.finally(() => playing.delete(finished));
  }
  /** The stream a message is part of, if any. */
  const streamOf = (/** @type {any} */ msg) => [...streams.values()].find((st) => p.belongs(msg, st, prompts));

  return {
    /** A line the fake harness wrote. */
    fromAgent(/** @type {string} */ line) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // not JSON (a stray log line): it goes through as it was
        out(line);
        return;
      }
      if (!msg || typeof msg !== 'object') return out(line);
      const d = p.delta(msg);
      if (d) {
        const st = streams.get(d.key);
        // the e2e fake's own text for a reply being replayed
        if (st && p.same(msg, st)) return;
        const arm = armed.has(d.key) ? d.key : armed.has(ANY_KEY) ? ANY_KEY : null;
        if (!st && arm !== null) {
          armed.delete(arm);
          const s = settings();
          if (s.mode === 'replay') return start(d.key, d.init, s);
        }
      }
      const st = streamOf(msg);
      if (!st) return out(line);
      if (!st.done) st.held.push(msg);
      else emit(msg, st);
    },
    /** A line MoPilot wrote to the harness. */
    fromClient(/** @type {string} */ line) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // the harness reports its own parse errors; nothing to follow here
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      p.client(msg, {
        cancel: (key) => streams.get(key)?.run?.cancel(),
        cancelAll: () => {
          for (const st of streams.values()) st.run?.cancel();
        },
        prompts,
      });
      // a turn the runner did not type takes the place of a marked one that never streamed
      const turn = p.armed(msg);
      if (turn?.marked) armed.add(turn.key);
      else if (turn) armed.delete(turn.key);
    },
    /** Whether a reply is playing. */
    busy: () => playing.size > 0,
    /** Resolves once every reply being played has finished and its held messages went out. */
    async idle() {
      while (playing.size) await Promise.all(playing);
    },
  };
}
