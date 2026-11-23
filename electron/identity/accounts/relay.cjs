// Local relay between the app-server and the Codex backend.
//
// The app-server is started with `-c openai_base_url=<relay>`, so every model request (HTTP and
// WebSocket) passes through here, and the relay decides which account serves it:
//  - each chat (the `session-id` header, which is the thread id) stays on one account, so that
//    account's prompt cache stays warm;
//  - new chats go to the account with the most usage left (Accounts.pickFor);
//  - a request refused for a usage limit or an expired token is replayed on another account before
//    Codex sees the error, so the turn simply continues.
// With a single account it is a plain pass-through. It listens on 127.0.0.1 under a random path and serves only the
// app-server or a process it started (relayPeers.cjs), so other local programs can't borrow the accounts' tokens.
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { parseJsonRecord } = require('../../../shared/jsonRecord.mjs');
const { noteIgnored } = require('../../ignored.cjs');
const { listenLoopback } = require('../../platform/listenLoopback.cjs');
const { HOP, stripHop, readAll, decode, pipeTo, fail } = require('../../platform/loopbackHttp.cjs');
const { RelayPeers } = require('./relayPeers.cjs');

// SAGE_RELAY_UPSTREAM is for tests against a local fake backend.
const upstreamBase = (env) => env.SAGE_RELAY_UPSTREAM || 'https://chatgpt.com/backend-api/codex';
const CHATGPT = upstreamBase(process.env);
const REALTIME = process.env.SAGE_RELAY_REALTIME_UPSTREAM || 'https://api.openai.com';
const client = (url) => (url.startsWith('http:') ? http : https);
/** A 429 that means "this account is out of usage" (not a transient rate limit Codex retries itself). */
function usageLimit(status, body) {
  if (status !== 429) return null;
  // not a JSON object: classify the 429 from an empty error
  const parsed = parseJsonRecord(body.toString('utf8'));
  /** @type {any} the backend's error object */
  const err = (parsed.ok && parsed.record.error) || {};
  const kind = String(err.type || err.code || '');
  if (!/usage_limit|usage_not_included|credits/i.test(kind)) return null;
  const resetsAt =
    Number(err.resets_at) || (Number(err.resets_in_seconds) ? Math.floor(Date.now() / 1000) + Number(err.resets_in_seconds) : null);
  return { resetsAt };
}

class Relay {
  /**
   * @param {InstanceType<typeof import('../codexAccounts.cjs').Accounts>} accounts
   * @param {ConstructorParameters<typeof RelayPeers>[1]} [o] the peer check and platform, for tests
   */
  constructor(accounts, o = {}) {
    this.accounts = accounts;
    /** who may use the relay: an app-server running now (MoMo's too), or a process it started */
    this.peers = new RelayPeers(() => this.accounts.server?.pids?.() ?? this.accounts.server?.proc?.pid, o);
    this.secret = crypto.randomBytes(18).toString('hex');
    this.base = null;
    this.realtimeBase = null;
    this.realtimeSidebandBase = null;
    this.server = null;
    this.listenRun = null;
    this.listening = null;
    /** Call id -> the account that created it, until its sideband attaches. */
    this.voiceCalls = new Map();
    /** open WebSocket connections per session: their account was fixed at the handshake */
    this.sockets = new Map();
  }

  /**
   * Close a session's WebSocket connections so its next request picks an account again (a chat
   * that was moved to another account). Codex reconnects on its own.
   */
  dropSession(session) {
    for (const s of this.sockets.get(session) ?? []) s.destroy();
    this.sockets.delete(session);
    for (const [id, call] of this.voiceCalls) if (call.session === session) this.voiceCalls.delete(id);
  }

  start() {
    if (this.listening) return this.listening;
    const listening = this.#serve();
    this.listening = listening;
    listening.catch(() => {
      if (this.listening === listening) this.listening = null;
    });
    return listening;
  }

  async #serve() {
    const server = http.createServer((req, res) => this.onRequest(req, res).catch(() => fail(res, 502, 'Relay error')));
    const run = { server, abort: new AbortController(), connections: new Set() };
    this.listenRun = run;
    this.server = server;
    server.on('connection', (socket) => {
      if (this.listenRun !== run) return socket.destroy();
      run.connections.add(socket);
      socket.on('close', () => run.connections.delete(socket));
    });
    server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head).catch(() => socket.destroy()));
    server.on('clientError', (_e, socket) => socket.destroy());
    let port;
    try {
      port = await listenLoopback(server, 0, run.abort.signal, 'model relay');
      if (this.listenRun !== run) throw new Error('The model relay was stopped while opening.');
    } catch (error) {
      this.#closeListener(run);
      throw error;
    }
    this.base = `http://127.0.0.1:${port}/${this.secret}`;
    // Codex uses /backend-api in this URL to select ChatGPT's JSON call creation
    // protocol. A bare relay URL selects the API's multipart /live protocol instead.
    this.realtimeBase = `${this.base}/backend-api/codex`;
    this.realtimeSidebandBase = `${this.base}/v1/live`;
    return this.base;
  }
  stop() {
    this.listening = null;
    this.voiceCalls.clear();
    this.sockets.clear();
    if (this.listenRun) this.#closeListener(this.listenRun);
  }

  #closeListener(run) {
    if (this.listenRun === run) {
      this.listenRun = null;
      this.server = null;
      this.base = null;
      this.realtimeBase = null;
      this.realtimeSidebandBase = null;
    }
    run.abort.abort();
    for (const socket of run.connections) socket.destroy();
    run.connections.clear();
    run.server.close();
  }

  pruneVoiceCalls() {
    for (const [id, call] of this.voiceCalls) if (Date.now() - call.at > 60_000) this.voiceCalls.delete(id);
  }

  /** Path after the secret prefix, or null for anything else. */
  route(url) {
    const prefix = `/${this.secret}`;
    if (!url.startsWith(prefix + '/') && url !== prefix) return null;
    const rest = url.slice(prefix.length);
    // This namespace preserves the backend protocol at the client; CHATGPT already
    // includes it upstream. Keep the query string (intent and architecture) intact.
    const backend = '/backend-api/codex';
    return rest.startsWith(backend + '/') ? rest.slice(backend.length) : rest;
  }

  /** Headers for the upstream request, signed as `tok`'s account (or untouched for pass-through). */
  headersFor(req, tok, extra = {}) {
    const h = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) h[k] = v;
    if (tok) {
      h.authorization = `Bearer ${tok.accessToken}`;
      h['chatgpt-account-id'] = tok.chatgptAccountId;
    }
    return { ...h, ...extra };
  }

  /**
   * Runs `attempt(account, token)` on the chosen account, then on others while it reports a usage
   * limit or an expired token. `attempt` resolves { status, headers, body?, done } where `done`
   * means the response was already handed to the client. Always resolves an answer: the last
   * refusal, or a 503 when no account could even be tried.
   */
  async withAccounts(session, attempt) {
    const tried = new Set();
    let last = null;
    for (let i = 0; i < 8; i++) {
      const acct = this.accounts.pickFor(session, tried);
      if (process.env.SAGE_RELAY_DEBUG)
        console.error('[relay] session', session, '->', acct === null ? 'pass-through' : (acct?.id ?? 'none'));
      if (acct === undefined) break;
      const current = acct ? this.accounts.usageRefresh.capture(acct.id) : alwaysCurrent;
      let tok = null;
      if (acct) {
        try {
          tok = await this.accounts.tokens(acct);
          if (!current()) return LOGIN_CHANGED;
        } catch (error) {
          if (!current() || error.code === 'ACCOUNT_CHANGED') return LOGIN_CHANGED;
          // this account can't sign in now: the next one is tried
          noteIgnored('read a Codex account token for the relay', error);
          tried.add(acct.id);
          continue;
        }
      }
      let r = await attempt(acct, tok);
      if (acct && r.status === 401 && !r.done) {
        // Stale access token: refresh once on the same account.
        if (!current()) return LOGIN_CHANGED;
        try {
          tok = await this.accounts.tokens(acct, true);
          if (!current()) return LOGIN_CHANGED;
          r = await attempt(acct, tok);
        } catch (error) {
          if (!current() || error.code === 'ACCOUNT_CHANGED') return LOGIN_CHANGED;
          // the refresh failed: the next account is tried, and this 401 is the answer if none works
          noteIgnored('refresh a Codex account token for the relay', error);
          tried.add(acct.id);
          last = r;
          continue;
        }
      }
      if (r.done) return r;
      if (acct && r.headers) this.accounts.noteUsageHeaders(acct, r.headers);
      const limit = acct ? usageLimit(r.status, r.body) : null;
      if (limit) {
        this.accounts.markLimited(acct, limit.resetsAt);
        tried.add(acct.id);
        last = r;
        continue;
      }
      if (acct && r.status === 401) {
        tried.add(acct.id);
        last = r;
        continue;
      }
      return r;
    }
    // nothing left to try before anything answered (no account, or none gave a token)
    return last ?? NO_ACCOUNT;
  }

  /* ---------- plain HTTP (Responses API over SSE, /models, compaction) ---------- */
  admits(socket) {
    return this.peers.admits(socket);
  }

  async onRequest(req, res) {
    const rest = this.route(req.url);
    if (rest == null) return fail(res, 404, 'Not found');
    const admitted = await this.admits(req.socket);
    // not told apart (a loaded machine): Codex retries a 5xx, and the next try asks again
    if (!admitted) return admitted === null ? fail(res, 503, 'The relay could not check this connection') : fail(res, 403, 'Not Codex');
    const body = await readAll(req);
    // API-key sign-ins carry no ChatGPT account and go straight to the OpenAI API.
    if (!req.headers['chatgpt-account-id']) return this.passThrough(req, res, this.accounts.apiBase() + rest, body);
    const session = req.headers['session-id'] || null;
    // a chat put on an API key goes to that key's endpoint, signed with it
    const keyed = this.accounts.keyRoute(session);
    if (keyed) return this.passThrough(req, res, keyed.base + rest, body, keyed.key);
    let closed = false;
    /** @type {import('node:http').ClientRequest | null} */
    let upstream = null;
    // Codex hung up (turn interrupted): stop the upstream request too.
    res.on('close', () => {
      closed = true;
      if (!res.writableFinished) upstream?.destroy();
    });

    const r = await this.withAccounts(
      session,
      (acct, tok) =>
        new Promise((resolve) => {
          if (closed) return resolve({ status: 499, done: true });
          const up = client(CHATGPT).request(CHATGPT + rest, {
            method: req.method,
            headers: { ...this.headersFor(req, tok), 'content-length': body.length },
          });
          upstream = up;
          up.on('response', async (u) => {
            // a client response always has its status
            const status = /** @type {number} */ (u.statusCode);
            // Error statuses are buffered so a usage-limit or auth failure can be replayed elsewhere.
            if (u.statusCode === 429 || u.statusCode === 401) {
              // an error answer cut short reads as empty: it is passed on as it came, not replayed
              const raw = await readAll(u).catch(
                (error) => (noteIgnored('read an error answer from the Codex backend', error), Buffer.alloc(0)),
              );
              return resolve({
                status: u.statusCode,
                headers: u.headers,
                rawHeaders: u.rawHeaders,
                body: decode(raw, u.headers['content-encoding']),
                raw,
              });
            }
            if (acct) this.accounts.noteUsageHeaders(acct, u.headers);
            if (req.method === 'POST' && rest.split('?')[0] === '/realtime/calls' && status >= 200 && status < 300) {
              // WebRTC's sideband uses a different origin, but must attach as this
              // exact account. Never replay an already-created call on another user.
              const location = u.headers.location;
              /** @type {string | null | undefined} */
              let callId = null;
              try {
                if (typeof location === 'string') callId = new URL(location, REALTIME).pathname.split('/').filter(Boolean).at(-1);
              } catch (error) {
                // malformed Location header: no call id to track, so its sideband can't attach as this account
                noteIgnored('read the voice call id from the Codex backend', error);
              }
              if (callId) {
                this.pruneVoiceCalls();
                const h = this.headersFor(req, tok);
                const auth = Object.fromEntries(['authorization', 'chatgpt-account-id'].filter((k) => h[k] != null).map((k) => [k, h[k]]));
                this.voiceCalls.set(callId, { acct, session, at: Date.now(), auth });
              }
            }
            res.writeHead(u.statusCode, stripHop(u.headers));
            pipeTo(u, res);
            resolve({ status: u.statusCode, done: true });
          });
          up.on('error', (e) =>
            resolve({ status: 502, headers: {}, body: Buffer.from(JSON.stringify({ error: { message: String(e.message) } })), raw: null }),
          );
          up.end(body);
        }),
    );
    if (r.done || res.headersSent) return;
    // every answer that reaches here is an attempt's buffered one: headers and body are always set
    res.writeHead(r.status, stripHop(r.headers));
    res.end(r.raw ?? r.body);
  }

  /** Forwards a request as is, or signed with `key` (and without the ChatGPT account header). */
  passThrough(req, res, url, body, key = null) {
    const headers = { ...this.headersFor(req, null), 'content-length': body.length };
    if (key) {
      headers.authorization = `Bearer ${key}`;
      delete headers['chatgpt-account-id'];
    }
    const up = client(url).request(url, { method: req.method, headers });
    up.on('response', (u) => {
      res.writeHead(u.statusCode, stripHop(u.headers));
      pipeTo(u, res);
    });
    up.on('error', (e) => fail(res, 502, String(e.message)));
    res.on('close', () => up.destroy());
    up.end(body);
  }

  /* ---------- WebSocket (Responses API over WS) ---------- */
  async onUpgrade(req, socket, head) {
    const rest = this.route(req.url);
    if (rest == null || !(await this.admits(socket))) return socket.destroy();
    const sideband = rest.startsWith('/v1/live/');
    this.pruneVoiceCalls();
    const callId = sideband ? rest.split('?')[0].slice('/v1/live/'.length) : null;
    const call = sideband ? this.voiceCalls.get(callId) : null;
    if (sideband ? !call : !req.headers['chatgpt-account-id']) return socket.destroy();
    if (call) this.voiceCalls.delete(callId);
    socket.on('error', () => {
      /* a reset socket is cleaned up by the close path; an unhandled error would crash main */
    });
    const session = call?.session || req.headers['session-id'] || null;
    // a chat on an API key uses HTTP, like an API-key sign-in
    if (!sideband && this.accounts.keyRoute(session)) return socket.destroy();
    const wsHeaders = { connection: 'Upgrade', upgrade: req.headers.upgrade || 'websocket' };
    const url = sideband ? REALTIME + rest : CHATGPT + rest;
    const attempt = (acct, tok) =>
      new Promise((resolve) => {
        if (socket.destroyed) return resolve({ status: 499, done: true });
        const auth = sideband && !acct ? call.auth : {};
        // agent: false: a handshake takes its socket over, and one refused with a kept-alive
        // response must not hand that socket to the next account's attempt
        const up = client(url).request(url, { method: 'GET', agent: false, headers: this.headersFor(req, tok, { ...auth, ...wsHeaders }) });
        const cancel = () => up.destroy();
        socket.on('close', cancel);
        socket.on('end', cancel);
        up.on('close', () => {
          socket.off('close', cancel);
          socket.off('end', cancel);
        });
        up.on('upgrade', (u, upSock, upHead) => {
          if (socket.destroyed) {
            upSock.destroy();
            return resolve({ status: 499, done: true });
          }
          if (acct) this.accounts.noteUsageHeaders(acct, u.headers);
          let reply = 'HTTP/1.1 101 Switching Protocols\r\n';
          for (let i = 0; i < u.rawHeaders.length; i += 2) reply += `${u.rawHeaders[i]}: ${u.rawHeaders[i + 1]}\r\n`;
          socket.write(reply + '\r\n');
          if (upHead?.length) socket.write(upHead);
          if (head?.length) upSock.write(head);
          upSock.on('error', () => socket.destroy());
          socket.on('close', () => upSock.destroy());
          upSock.on('close', () => socket.destroy());
          upSock.pipe(socket);
          socket.pipe(upSock);
          if (session) {
            const set = this.sockets.get(session) ?? new Set();
            set.add(socket);
            this.sockets.set(session, set);
            socket.on('close', () => {
              set.delete(socket);
              if (!set.size && this.sockets.get(session) === set) this.sockets.delete(session);
            });
          }
          resolve({ status: 101, done: true });
        });
        up.on('response', async (u) => {
          // an answer cut short reads as empty and is passed on with its status
          const raw = await readAll(u).catch((error) => (noteIgnored('read an answer from the Codex backend', error), Buffer.alloc(0)));
          resolve({
            status: u.statusCode,
            headers: u.headers,
            rawHeaders: u.rawHeaders,
            body: decode(raw, u.headers['content-encoding']),
            raw,
          });
        });
        up.on('error', () => resolve({ status: 502, headers: {}, body: Buffer.alloc(0), raw: null }));
        up.end();
      });
    // Responses can fail over at the handshake. A voice sideband can only refresh
    // the account that owns its call, even if the active account changed meanwhile.
    let r;
    if (sideband) {
      const current = call.acct ? this.accounts.usageRefresh.capture(call.acct.id) : alwaysCurrent;
      try {
        let tok = call.acct ? await this.accounts.tokens(call.acct) : null;
        r = current() ? await attempt(call.acct, tok) : LOGIN_CHANGED;
        if (call.acct && r?.status === 401 && !r.done) {
          if (!current()) r = LOGIN_CHANGED;
          else {
            tok = await this.accounts.tokens(call.acct, true);
            r = current() ? await attempt(call.acct, tok) : LOGIN_CHANGED;
          }
        }
      } catch (error) {
        if (current() && error.code !== 'ACCOUNT_CHANGED') throw error;
        r = LOGIN_CHANGED;
      }
    } else r = await this.withAccounts(session, attempt);
    // done: the handshake was answered (a live socket) or the client already left
    if (r.done || socket.destroyed) return;
    let reply = `HTTP/1.1 ${r.status} ${http.STATUS_CODES[r.status] || ''}\r\n`;
    // every refusal that reaches here was buffered by an attempt: headers and body are always set
    const raw = r.raw ?? r.body;
    const hdrs = { ...stripHop(r.headers), 'content-length': raw.length, connection: 'close' };
    for (const [k, v] of Object.entries(hdrs)) reply += `${k}: ${v}\r\n`;
    socket.end(Buffer.concat([Buffer.from(reply + '\r\n'), raw]));
  }
}

const NO_ACCOUNT = Object.freeze({
  status: 503,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(
    JSON.stringify({ error: { message: 'No ChatGPT account is available for this request. Sign in again in MoPilot settings.' } }),
  ),
  raw: null,
});

const alwaysCurrent = () => true;
const LOGIN_CHANGED = Object.freeze({
  ...NO_ACCOUNT,
  body: Buffer.from(JSON.stringify({ error: { message: 'The login changed. Retry with the current sign-in.' } })),
});

module.exports = { Relay, usageLimit, upstreamBase };
