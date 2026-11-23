// The app's half of the tool relay (Host work package 2.6): a harness that runs on a Host calls MoPilot's tools through the Host's tool socket, the Host hands each call to this app
// as a `tool` event, and the app runs it through its own registry (approvals, site permission and the chat's tabs on its Host stay as they are) and answers with `host.toolResult`.
//
// Per Host connection: the app announces its tools when the connection comes up (and again after every reconnect), runs each call it is sent, and lets go of a call the Host cancels
// or whose connection went. A call's answer is fitted to what one message may carry before it is sent.
const { localBrowserData } = require('../capabilities/contract/localBrowserData.cjs');
const { MAX_FRAME } = require('../../shared/host/frames.mjs');

const MAX_BLOCKS = 64;
const MAX_TEXT = 1024 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;
/** What one answer may carry in all: a frame less its envelope (shared/host/toolRelay.mjs), less room for the notes this file adds. */
const MAX_RESULT = MAX_FRAME - 64 * 1024 - 1024;
const MAX_CODE = 64;
const MAX_MESSAGE = 16 * 1024;
const CUT = '\n[cut: too long to pass on]';
/** What a message that is too big in bytes (the budgets above count characters) is answered with, so the harness is not left waiting for its timeout. */
const TOO_BIG = { ok: false, content: [], error: { code: 'too_large', message: 'The result was too large to pass on.' } };
const IMAGE_TYPE = /^image\/[\w.+-]{1,40}$/;

const isRecord = (/** @type {unknown} */ v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isId = (/** @type {unknown} */ v) => typeof v === 'string' && v.length > 0;

/** A text block cut to `max` characters, with a note that it was cut. @param {string} text @param {number} max */
const cutText = (text, max) =>
  text.length <= max ? text : max <= CUT.length ? text.slice(0, max) : `${text.slice(0, max - CUT.length)}${CUT}`;

/**
 * A tool's result blocks as the wire carries them: text and images only, at most 64, each within its limit and all within one message.
 * Anything that does not fit is replaced by a note in text, never dropped without saying so.
 * @param {unknown} content
 * @returns {({ type: 'text', text: string } | { type: 'image', data: string, mimeType: string })[]}
 */
function fit(content) {
  const blocks = Array.isArray(content) ? content : [];
  /** @type {({ type: 'text', text: string } | { type: 'image', data: string, mimeType: string })[]} */
  const out = [];
  let size = 0;
  const room = () => MAX_RESULT - size;
  for (const b of blocks) {
    // too many blocks, or no room left: the rest is told in one note
    if ((blocks.length > MAX_BLOCKS && out.length >= MAX_BLOCKS - 1) || room() <= 0) {
      out.push({ type: 'text', text: `[${blocks.length - out.length} more blocks were not passed on]` });
      break;
    }
    const image =
      isRecord(b) && b.type === 'image' && typeof b.data === 'string' && typeof b.mimeType === 'string' && IMAGE_TYPE.test(b.mimeType);
    if (image && b.data.length <= MAX_IMAGE && b.data.length <= room()) {
      out.push({ type: 'image', data: b.data, mimeType: b.mimeType });
      size += b.data.length;
      continue;
    }
    // a block the wire cannot carry (another kind, or an image too big) is told in words
    const text = image
      ? 'An image was too large to pass on.'
      : isRecord(b) && typeof b.text === 'string'
        ? b.text
        : (JSON.stringify(b) ?? '');
    const piece = cutText(text, Math.min(MAX_TEXT, Math.max(0, room())));
    out.push({ type: 'text', text: piece });
    size += piece.length;
  }
  return out;
}

/** The registry's result as the wire's `host.toolResult` body. @param {any} res */
function answerOf(res) {
  const content = fit(res?.content);
  if (res?.ok) return { ok: true, content, ...(res.endsTurn === true ? { endsTurn: true } : {}) };
  const e = res?.error;
  return {
    ok: false,
    content,
    error: {
      code: (typeof e?.code === 'string' && e.code ? e.code : 'failed').slice(0, MAX_CODE),
      message: cutText(typeof e?.message === 'string' ? e.message : 'The tool failed.', MAX_MESSAGE),
    },
  };
}

/**
 * @param {object} o
 * @param {{ tools: { request: (method: string, params: object) => Promise<any>, onEvent: (fn: (event: any) => void) => () => void },
 *           hostInfo: () => { state: string }, onState: (fn: (s: string) => void) => () => void }} o.host a remote Host (remote.cjs)
 * @param {{ list: () => { name: string, description?: string, inputSchema?: object, policy: string }[],
 *           invoke: (chatId: string, segmentId: string, name: string, args: unknown, o: { callId: string, signal: AbortSignal }) => Promise<any>,
 *           abortChat?: (chatId: string, why: 'stopped') => unknown }} o.registry the app's tools
 * @param {(tool: { name: string }) => boolean} [o.include] which of the app's tools a harness on the Host is told about, and the only ones it may call
 * @param {(chatId: string) => boolean} [o.owns] whether the chat runs on this Host; a call for any other chat (one of this Mac's own, another machine's) is refused. Without it nothing runs
 * @param {(what: string, error: unknown) => void} [o.report] a failure nobody else is told of
 */
function createToolRelay({ host, registry, include = () => true, owns = () => false, report = () => undefined }) {
  let disposed = false;
  /** The calls under way: `${chatId}\n${callId}` -> the abort that ends the run. @type {Map<string, AbortController>} */
  const running = new Map();

  /** The app's tools, announced to the Host (replacing what an earlier connection said). */
  function announce() {
    if (disposed) return;
    const tools = registry.list().filter(include);
    host.tools.request('host.toolsSync', { tools }).catch((error) => {
      // a Host without the `tools` feature is simply not served
      if (!error?.missing?.includes('tools')) report('announce the app’s tools to a Host', error);
    });
  }

  /** The connection went: what was running has no one to answer to. */
  function releaseAll() {
    for (const ac of running.values()) ac.abort();
    running.clear();
  }

  /** @param {any} event */
  async function onTool(event) {
    const { chatId, segmentId, callId, name, epoch } = event;
    if (![chatId, segmentId, callId, name].every(isId) || !Number.isSafeInteger(epoch))
      return report('read a tool call from a Host', new Error('The call names no chat, segment, call, tool or epoch.'));
    // the Host is another machine's output: it may call only what this app announced to it, and only for a chat that runs on it (never one of this Mac's own, whose grants and approvals are not the Host's to use)
    if (!registry.list().some((t) => t.name === name && include(t)) || !owns(chatId)) {
      report(
        'refuse a tool call from a Host',
        new Error(`The Host asked for ${String(name).slice(0, 64)}, which it may not call for that chat.`),
      );
      // a Host that was told of the tool (the list changed since) or of the chat waits for an answer: it gets a refusal, not a silence until its timeout
      return void (await host.tools
        .request('host.toolResult', {
          chatId,
          callId,
          epoch,
          ok: false,
          content: [],
          error: { code: 'unavailable', message: 'This app does not offer that tool for the chat now.' },
        })
        .catch((error) => report('answer a refused tool call from a Host', error)));
    }
    const key = `${chatId}\n${callId}`;
    if (running.has(key)) return;
    const ac = new AbortController();
    running.set(key, ac);
    let res;
    try {
      res = await registry.invoke(chatId, segmentId, name, isRecord(event.arguments) ? event.arguments : {}, { callId, signal: ac.signal });
    } finally {
      if (running.get(key) === ac) running.delete(key);
    }
    // cancelled, or the connection went, while it ran: the Host has already ended the call
    if (ac.signal.aborted || disposed) return;
    const body = answerOf(res);
    const answer = Buffer.byteLength(JSON.stringify(body)) > MAX_RESULT ? TOO_BIG : body;
    await host.tools
      .request('host.toolResult', { chatId, callId, epoch, ...answer })
      .catch((error) => report('answer a tool call from a Host', error));
  }

  /**
   * The Host cancelled a call (the user's Stop reached the Host, the harness gave up on it, or it timed out). The call ends, and the chat's tabs are stopped
   * as a Stop here would stop them (the registry's abort listeners tell the Host browser to cancel what it is loading); without that the page keeps
   * loading on the Host and the next turn's first commands wait behind it.
   * @param {unknown} chatId @param {unknown} callId
   */
  function cancel(chatId, callId) {
    const ac = running.get(`${chatId}\n${callId}`);
    if (!ac) return;
    ac.abort();
    registry.abortChat?.(String(chatId), 'stopped');
  }

  const offEvent = host.tools.onEvent((event) => {
    if (disposed) return;
    if (event?.event === 'tool') return void onTool(event).catch((error) => report('run a tool call from a Host', error));
    if (event?.event === 'toolCancel') cancel(event.chatId, event.callId);
  });
  const offState = host.onState((s) => (s === 'online' ? announce() : releaseAll()));
  if (host.hostInfo().state === 'online') announce();

  return {
    /** The app's tools changed: tell the Host again. */
    resync: announce,
    dispose() {
      disposed = true;
      offEvent();
      offState();
      releaseAll();
    },
  };
}

/**
 * The tools of this app a harness running on a Host may be told about: the browser's page tools (the Host runs a browser for them; this Mac's stores/files/preview processes are excluded) and the desktop's (a Host with its own desktop serves it, G8 #3903; hostToolsFor holds them back from one that has none). Everything else of this Mac's (the user's Chrome, the older computer_* tools, the app's own tools) is not announced.
 * @param {{ name: string }} tool
 */
const hostToolFamily = (tool) => /^(browser|desktop)_/.test(tool.name) && !localBrowserData(tool.name);

/**
 * What one Host is told of: the browser's tools always, the desktop's only while that Host says it has a desktop (a Host without one would show the model tools that only fail). `resync` the relay when this flips.
 * @param {() => boolean} hasDesktop whether the Host reports `desktop` now
 */
const hostToolsFor = (hasDesktop) => (/** @type {{ name: string }} */ tool) =>
  hostToolFamily(tool) && (!tool.name.startsWith('desktop_') || hasDesktop());

module.exports = { createToolRelay, fit, answerOf, hostToolFamily, hostToolsFor };
