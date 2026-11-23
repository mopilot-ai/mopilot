// ACP JSON-RPC framing, requests, replies and pending-request cleanup over stdio.
const { clock } = require('../../platform/ports/clock.cjs');
const { IncomingRequests, DEFERRED_REPLY, validId } = require('./incoming.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { JsonReader } = require('../../transport/jsonReader.cjs');
const { prefixCodePoints } = require('../../../shared/textPrefix.mjs');

/** How much of an agent's detail is shown: its first line, at most this many characters (not a whole stack trace). */
const DETAIL_MAX = 300;

class RpcError extends Error {
  /** @param [said] the agent's own message, without the detail from data: what classifying the failure reads */
  constructor(code, message, data, said = message) {
    super(message);
    this.code = code;
    this.data = data;
    this.said = said;
  }
}

/**
 * What an agent's error says, with the detail it put in `data` (a string, or `details` / `message` in it): many agents
 * answer a bare "Internal error" there and say why only in `data` (Qwen Code's missing API key, Goose's missing
 * provider). A detail that already contains the message replaces it rather than repeating it.
 */
function agentErrorText(error) {
  const message = typeof error?.message === 'string' && error.message ? error.message : 'error';
  const d = error?.data;
  const raw = typeof d === 'string' ? d : typeof d?.details === 'string' ? d.details : typeof d?.message === 'string' ? d.message : '';
  const line =
    raw
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? '';
  const detail = line.length > DETAIL_MAX ? `${prefixCodePoints(line, DETAIL_MAX)}…` : line;
  if (!detail || message.includes(detail)) return message;
  return detail.includes(message) ? detail : `${message}: ${detail}`;
}

/** A request the caller stopped waiting for (an aborted signal), told apart from the agent's own failures. */
class Cancelled extends Error {
  constructor(method) {
    super(`${method} was cancelled`);
    this.name = 'Cancelled';
    this.cancelled = true;
  }
}

class RpcPeer {
  /**
   * @param {object} o
   * @param o.input readable (the agent's stdout)
   * @param o.output writable (its stdin)
   * @param o.onRequest (method, params) => result | Promise<result>; throw an RpcError to answer with an error
   * @param [o.onNotification] (method, params) => void
   * @param [o.onFailure] (error: Error) => void: retire the owning process when the reader fails
   */
  constructor({ input, output, onRequest, onNotification, onFailure }) {
    this.output = output;
    this.onRequest = onRequest;
    this.onNotification = onNotification;
    this.pending = new Map();
    this.incoming = new IncomingRequests(this);
    this.next = 1;
    this.closed = null;
    this.reader = new JsonReader({
      stream: input,
      onValue: (msg) => this.receive(msg),
      onError: (error) => {
        this.close(error);
        onFailure?.(error);
      },
    });
    input.on('data', (chunk) => this.reader.push(chunk));
  }
  /**
   * Sends one message; throws when it cannot be encoded or the stream refuses it at once. A pipe that
   * breaks later is reported through the stream's 'error' and the agent's exit, which closes this peer.
   */
  send(msg) {
    this.output.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  }
  /** Sends a message nothing waits on (a notification, an answer); one that cannot go is recorded. */
  write(msg) {
    if (this.closed) return;
    try {
      this.send(msg);
    } catch (error) {
      // the agent's stdin closed: its exit is handled separately
      noteIgnored(`send ${msg.method ?? 'an answer'} to the ACP agent`, error);
    }
  }
  receive(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.method && msg.id != null) {
      if (!this.incoming.live.has(msg.id)) void this.answer(msg);
      return;
    }
    if (msg.method) {
      if (msg.method === '$/cancel_request') this.incoming.cancel(msg.params?.requestId);
      try {
        this.onNotification?.(msg.method, msg.params ?? {});
      } catch (error) {
        // a listener error must not stop reading the agent's stream
        noteIgnored(`handle the ACP agent's ${msg.method}`, error);
      }
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new RpcError(msg.error.code, agentErrorText(msg.error), msg.error.data, msg.error.message));
    else p.resolve(msg.result);
  }
  async answer(msg) {
    try {
      const context = this.incoming.context(msg.id);
      const result = await this.onRequest(msg.method, msg.params ?? {}, context);
      if (result === DEFERRED_REPLY) return;
      // an answer that cannot be encoded goes back as an error, so the agent does not wait for it
      if (!this.closed) this.send({ id: msg.id, result: result ?? null });
    } catch (e) {
      this.write({
        id: validId(msg.id) ? msg.id : null,
        error: { code: typeof e?.code === 'number' ? e.code : -32603, message: String(e?.message ?? e) },
      });
    }
  }
  /**
   * @param {string} method
   * @param params
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts] an aborted signal stops waiting and asks the agent
   *   to drop the request (ACP's $/cancel_request); the promise rejects with a Cancelled error
   */
  request(method, params, { timeoutMs, signal } = {}) {
    if (this.closed) return Promise.reject(this.closed);
    if (signal?.aborted) return Promise.reject(new Cancelled(method));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      // every way it ends (answer, close, timeout, abort, a send that fails) stops the timer and the abort listener
      const done = () => (clock.clearTimeout(timer), signal?.removeEventListener('abort', abort));
      const timer = timeoutMs
        ? clock.setTimeout(() => (this.pending.delete(id), done(), reject(new Error(`${method} timed out`))), timeoutMs)
        : undefined;
      const abort = () => {
        this.pending.delete(id);
        done();
        this.notify('$/cancel_request', { requestId: id });
        reject(new Cancelled(method));
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        resolve: (v) => (done(), resolve(v)),
        reject: (e) => (done(), reject(e)),
      });
      // a request that never went out fails now instead of waiting for an answer that cannot come
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        done();
        reject(error);
      }
    });
  }
  notify(method, params) {
    this.write({ method, params });
  }
  close(err) {
    this.reader.close();
    this.closed = err ?? new Error('closed');
    this.incoming.close();
    for (const p of this.pending.values()) p.reject(this.closed);
    this.pending.clear();
  }

  finishInput(done) {
    this.reader.finishInput(done);
  }
}

module.exports = { RpcError, RpcPeer, Cancelled, agentErrorText, DETAIL_MAX };
