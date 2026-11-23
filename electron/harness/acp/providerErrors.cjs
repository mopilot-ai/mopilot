// A basic harness's provider failures read from its stderr (#1534): a harness that retries a failing provider in
// silence (opencode answers no update and no prompt result while it backs off) still says why in its own log, so a
// quirk's `providerError(line)` names the failure and the chat whose prompt runs shows it while the harness retries.

/** How much of one stderr line is read: a log line past this is not a provider error worth showing. */
const LINE_MAX = 8000;

/**
 * Calls `onLine` with each whole line of a stream's text chunks; a line split across chunks is joined first.
 * @param {(line: string) => void} onLine
 */
function lineReader(onLine) {
  let rest = '';
  // the rest of a line cut for its length is dropped too, up to its end
  let skipping = false;
  return (/** @type {string} */ chunk) => {
    const parts = (rest + String(chunk)).split(/\r?\n/);
    rest = /** @type {string} */ (parts.pop());
    for (const line of parts) {
      if (!skipping && line.trim()) onLine(line.slice(0, LINE_MAX));
      skipping = false;
    }
    if (rest.length > LINE_MAX) {
      rest = '';
      skipping = true;
    }
  };
}

/** One logfmt field's value (`key=value` or `key="quoted \"value\""`), or null. */
function field(line, key) {
  const re = new RegExp(`(?:^|\\s)${key.replace(/\./g, '\\.')}=(?:"((?:[^"\\\\]|\\\\.)*)"|(\\S+))`);
  const m = re.exec(line);
  if (!m) return null;
  return m[1] != null ? m[1].replace(/\\(.)/g, '$1') : m[2];
}

/**
 * opencode's stream error as `--print-logs` writes it:
 *   level=ERROR … message="stream error" … session.id=ses_… small=false agent=build … error.error="AI_APICallError: Rate limit exceeded"
 * Only the session's own model counts: its title helper (small=true) fails the same way and says nothing new.
 * @returns {{ sessionId: string | null, text: string } | null}
 */
function opencodeStreamError(line) {
  if (typeof line !== 'string' || field(line, 'message') !== 'stream error') return null;
  if (field(line, 'small') === 'true') return null;
  const raw = field(line, 'error.error') ?? field(line, 'error.message') ?? field(line, 'error');
  if (!raw?.trim()) return null;
  // "AI_APICallError: Rate limit exceeded" reads as the provider's own words
  const text = raw.replace(/^(AI_)?\w*Error:\s*/, '').trim() || raw.trim();
  return { sessionId: field(line, 'session.id'), text };
}

/** @typedef {{ chatOf(agent: object, sessionId: string): any, chats: Map<string, any>, emitEvent(e: object): void }} ErrorHost */

/**
 * The chat a provider error belongs to: the one with that session on the agent, or, when the line names no session,
 * the agent's only chat with a prompt running. A line that fits no running prompt is not shown (nothing waits on it).
 * @param {Omit<ErrorHost, 'emitEvent'>} host
 */
function promptingChat(host, agent, sessionId) {
  if (sessionId) {
    const chat = host.chatOf(agent, sessionId);
    return chat?.prompting ? chat : null;
  }
  const running = [...host.chats.values()].filter((c) => c.agent === agent && c.prompting);
  return running.length === 1 ? running[0] : null;
}

/**
 * Watch an agent's stderr for its quirk's provider errors: each one is kept on the running prompt (its turn's error
 * if the prompt then fails without one) and goes to windows and the request ledger as `providerError`.
 * @param {ErrorHost} host the AcpHost
 * @param {import('node:events').EventEmitter} agent emits 'stderr' with text chunks
 * @param {((line: string) => { sessionId?: string | null, text: string } | null) | undefined} parse the quirk's reader
 */
function watchProviderErrors(host, agent, parse) {
  if (typeof parse !== 'function') return;
  agent.on(
    'stderr',
    lineReader((line) => {
      const found = parse(line);
      if (!found || typeof found.text !== 'string') return;
      const text = found.text.trim();
      if (!text) return;
      const chat = promptingChat(host, agent, found.sessionId ?? null);
      // a prompt already stopped is ending: what its harness still logs is not shown or charged
      if (!chat || chat.prompting.cancelled) return;
      chat.prompting.providerError = text;
      host.emitEvent({ key: chat.key, kind: 'providerError', turnId: chat.prompting.turnId, error: text });
    }),
  );
}

/**
 * A turn's error fields as its end records them: a prompt that failed with no error of its own failed for the provider
 * failure its harness kept retrying, and a failed or stopped turn keeps that failure as `providerError` so the chat
 * can say why it got nowhere (shared/acpStop.mjs). A turn that ended well recovered from it: nothing is kept.
 * @param {{ providerError?: string, audio?: boolean }} run @param {string} reason the turn's stop reason @param {string | null} error
 */
function endWhy(run, reason, error) {
  const said = reason === 'cancelled' || reason === 'error' ? run.providerError : undefined;
  return { error: error ?? (reason === 'error' ? (said ?? null) : null), ...(said ? { providerError: said } : {}) };
}

module.exports = { lineReader, opencodeStreamError, watchProviderErrors, promptingChat, endWhy };
