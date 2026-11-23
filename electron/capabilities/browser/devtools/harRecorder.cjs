// browser_har: the network traffic of a chat's tabs as a HAR 1.2 file in the chat's upload folder, from each tab's CDP Network events.
//
// What a HAR keeps out (it is a file the agent may attach anywhere):
// - secret headers (cookies, authorization, tokens, API keys, CSRF) are REDACTED; secret query parameters too (redactUrl);
// - request bodies of a page with a password field, of a high-risk site or of a URL with credentials are left out, and
//   form and JSON fields named like a secret (password, token, card, cvc, otp, ...) are REDACTED in the others;
// - response bodies are kept only for text (HTML, JSON, script, CSS, XML) of ordinary pages, at most MAX_BODY each and
//   MAX_BODIES in all; other bodies keep their size only.
// Recording follows the chat's tabs: the tab it started on, and each tab a tool call reaches (hostPageGates.cjs touch).
// It ends on stop, at MAX_ENTRIES, or when the chat's turn ends (the debugger lets go then): saved either way.
const { noteIgnored } = require('../../../ignored.cjs');
const { prefixUnits } = require('../../../../shared/textPrefix.mjs');
const { redactUrl } = require('../hostUtil.cjs');
const { PROBE_MS, credentialFieldIn } = require('../credentialProbe.cjs');

const MAX_ENTRIES = 5000;
const MAX_BODY = 1024 * 1024;
const MAX_BODIES = 50 * 1024 * 1024;
const MAX_POST = 64 * 1024;
const SECRET_HEADER = /cookie|authori[sz]ation|token|secret|api[-_]?key|session|csrf|xsrf|password|signature/i;
const SECRET_FIELD =
  /pass(word|wd|code)?|pwd|secret|token|otp|one[-_]?time|cvc|cvv|card|iban|ssn|pin\b|auth|credential|session|api[-_]?key/i;
const TEXT_MIME =
  /^(text\/|application\/(json|[a-z.+-]*\+json|javascript|ecmascript|x-javascript|xml|[a-z.+-]*\+xml|x-www-form-urlencoded|graphql))/i;
const REDACTED = 'REDACTED';

/** Headers as HAR name/value pairs, secrets REDACTED. */
/** Headers whose value is a URL: its secret query parameters are REDACTED as the request's own URL's are. */
const URL_HEADER = /^(referer|location|content-location|origin)$/i;
const headersOf = (/** @type {Record<string, string> | undefined} */ h) =>
  Object.entries(h ?? {}).map(([name, value]) => ({
    name,
    value: SECRET_HEADER.test(name) ? REDACTED : URL_HEADER.test(name) ? redactUrl(String(value)) : String(value),
  }));

/** A JSON value with every field named like a secret REDACTED. */
function maskJson(/** @type {any} */ v) {
  if (Array.isArray(v)) return v.map(maskJson);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_FIELD.test(k) ? REDACTED : maskJson(x)]));
}

/** A request body with its secret-looking fields REDACTED (a form or JSON), or cut to MAX_POST. */
function maskPost(/** @type {string} */ text, /** @type {string} */ mime) {
  if (/x-www-form-urlencoded/i.test(mime)) {
    const form = new URLSearchParams(text);
    for (const [k] of [...form]) if (SECRET_FIELD.test(k)) form.set(k, REDACTED);
    return form.toString();
  }
  if (/json/i.test(mime)) {
    try {
      return JSON.stringify(maskJson(JSON.parse(text)));
    } catch (error) {
      // not JSON after all: cut like any other body
      noteIgnored('mask a request body that says it is JSON', error);
    }
  }
  return text.length > MAX_POST ? `${prefixUnits(text, MAX_POST)}…` : text;
}

const queryOf = (/** @type {string} */ url) => {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
};
const headerValue = (/** @type {Record<string, string> | undefined} */ h, /** @type {string} */ name) =>
  Object.entries(h ?? {}).find(([k]) => k.toLowerCase() === name)?.[1] ?? '';
const span = (/** @type {number} */ a, /** @type {number} */ b) => (a >= 0 && b >= a ? b - a : -1);
const ms = (/** @type {number} */ n) => Math.round(n * 1000) / 1000;

/**
 * HAR timings from CDP's ResourceTiming (ms after requestTime) and the end time (s); every phase is >= 0 or -1.
 * @param {any} t @param {number} startS @param {number} endS
 */
function timingsOf(t, startS, endS) {
  const total = Math.max(0, (endS - startS) * 1000);
  if (!t) return { time: ms(total), timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: ms(total), receive: 0 } };
  const offset = Math.max(0, (t.requestTime - startS) * 1000);
  const dns = span(t.dnsStart, t.dnsEnd);
  const connect = span(t.connectStart, t.connectEnd);
  const ssl = span(t.sslStart, t.sslEnd);
  const send = Math.max(0, t.sendEnd - t.sendStart);
  const wait = Math.max(0, t.receiveHeadersEnd - t.sendEnd);
  const blocked = offset + Math.max(0, t.sendStart - Math.max(0, connect >= 0 ? t.connectEnd : dns >= 0 ? t.dnsEnd : 0));
  const receive = Math.max(0, total - offset - Math.max(0, t.receiveHeadersEnd));
  const timings = {
    blocked: ms(blocked),
    dns: ms(dns),
    connect: ms(connect),
    ssl: ms(ssl),
    send: ms(send),
    wait: ms(wait),
    receive: ms(receive),
  };
  // ssl is part of connect in HAR: it is not counted twice
  const time = [blocked, dns, connect, send, wait, receive].filter((x) => x > 0).reduce((a, b) => a + b, 0);
  return { time: ms(time), timings };
}

/**
 * @typedef {{ chatId: string, started: number, entries: Map<string, any>, order: string[], pages: any[], pageOf: Map<any, string>,
 *             tabs: Map<any, { dbg: any, listener: (...a: any[]) => void }>, bodies: number, dropped: number, why: string | null }} HarRecording
 */

class HarRecorder {
  /**
   * @param {{ riskOf?: (url: string) => { level: string, credentials?: boolean }, now?: () => number,
   *           maxEntries?: number, maxBody?: number, maxBodies?: number }} o
   */
  constructor({
    riskOf = () => ({ level: 'normal' }),
    now = Date.now,
    maxEntries = MAX_ENTRIES,
    maxBody = MAX_BODY,
    maxBodies = MAX_BODIES,
  } = {}) {
    this.riskOf = riskOf;
    this.now = now;
    this.maxEntries = maxEntries;
    this.maxBody = maxBody;
    this.maxBodies = maxBodies;
    /** @type {Map<string, HarRecording>} */
    this.chats = new Map();
    /** chat -> a recording that ended on its own (turn end, cap), kept for the next call to save */
    this.ended = new Map();
    /** tab -> whether its page had a password field at its last tool call */
    this.passwords = new WeakMap();
  }

  /** Starts recording the chat's traffic with `tab`; returns the recording it replaced (not saved), or null. */
  async start(/** @type {string} */ chatId, tab) {
    const before = this.stop(chatId);
    this.ended.delete(chatId);
    /** @type {HarRecording} */
    const rec = {
      chatId,
      started: this.now(),
      entries: new Map(),
      order: [],
      pages: [],
      pageOf: new Map(),
      tabs: new Map(),
      bodies: 0,
      dropped: 0,
      why: null,
    };
    this.chats.set(chatId, rec);
    await this.touch(tab);
    return before;
  }

  /** Ends the chat's recording (its listeners go); returns it, or null. */
  stop(/** @type {string} */ chatId) {
    const rec = this.chats.get(chatId) ?? this.ended.get(chatId) ?? null;
    this.chats.delete(chatId);
    this.ended.delete(chatId);
    if (rec) for (const [, w] of rec.tabs) w.dbg.removeListener?.('message', w.listener);
    rec?.tabs.clear();
    return rec;
  }

  endTurn(/** @type {string} */ chatId) {
    const rec = this.chats.get(chatId);
    if (!rec) return;
    this.stop(chatId);
    rec.why ??= 'the turn ended';
    this.ended.set(chatId, rec);
  }

  /** A tool call on `tab`: while its chat records, its traffic is heard from now on. Never throws. */
  async touch(tab) {
    const rec = this.chats.get(tab.chatId);
    if (!rec) return;
    try {
      this.passwords.set(tab, await credentialFieldIn(tab, { ms: PROBE_MS, unreadable: true }));
      const dbg = tab.backend?.debugger;
      if (typeof dbg?.on !== 'function' || rec.tabs.get(tab)?.dbg === dbg) return;
      rec.tabs.get(tab)?.dbg.removeListener?.('message', rec.tabs.get(tab)?.listener);
      const listener = (/** @type {any} */ _e, /** @type {string} */ method, /** @type {any} */ p, /** @type {string} */ sessionId = '') =>
        this.event(rec, tab, method, p, sessionId);
      dbg.on('message', listener);
      rec.tabs.set(tab, { dbg, listener });
      if (!rec.pageOf.has(tab)) this.#page(rec, tab, tab.url, tab.title);
    } catch (error) {
      noteIgnored('listen to the network of a tab for a HAR', error);
    }
  }

  /** Whether the tab's page may have its bodies kept. */
  #open(tab) {
    const risk = tab.url ? this.riskOf(tab.url) : null;
    return !this.passwords.get(tab) && !!risk && risk.level === 'normal' && !risk.credentials;
  }

  #page(/** @type {HarRecording} */ rec, tab, /** @type {string} */ url, /** @type {string} */ title) {
    const id = `page_${rec.pages.length + 1}`;
    rec.pages.push({
      startedDateTime: new Date(this.now()).toISOString(),
      id,
      title: String(title || redactUrl(url || '')),
      pageTimings: {},
    });
    rec.pageOf.set(tab, id);
  }

  /** One CDP event of a recorded tab. */
  event(/** @type {HarRecording} */ rec, tab, /** @type {string} */ method, /** @type {any} */ p, /** @type {string} */ sessionId) {
    if (this.chats.get(rec.chatId) !== rec) return;
    const key = `${sessionId}:${p?.requestId}`;
    switch (method) {
      case 'Page.frameNavigated':
        if (!sessionId && !p.frame?.parentId) this.#page(rec, tab, p.frame?.url, '');
        return;
      case 'Network.requestWillBeSent': {
        const prev = rec.entries.get(key);
        // a redirect: the earlier hop ends with the redirect's response, and the next hop is an entry of its own
        if (prev && p.redirectResponse) {
          this.#response(prev, p.redirectResponse);
          this.#finish(prev, p.timestamp);
          rec.entries.delete(key);
          rec.entries.set(`${key}#${prev.hop + 1}`, prev);
        }
        if (rec.order.length >= this.maxEntries) {
          rec.dropped++;
          return;
        }
        const req = p.request ?? {};
        const mime = headerValue(req.headers, 'content-type');
        const post = req.postData != null ? (this.#open(tab) ? maskPost(String(req.postData), mime) : null) : undefined;
        const url = redactUrl(req.url ?? '');
        const entry = {
          hop: prev ? prev.hop + 1 : 0,
          sessionId,
          requestId: p.requestId,
          open: this.#open(tab),
          startS: p.timestamp,
          timing: null,
          har: {
            pageref: rec.pageOf.get(tab),
            startedDateTime: new Date((p.wallTime ?? this.now() / 1000) * 1000).toISOString(),
            time: 0,
            request: {
              method: req.method ?? 'GET',
              url,
              httpVersion: 'HTTP/1.1',
              cookies: [],
              headers: headersOf(req.headers),
              queryString: queryOf(url),
              ...(post !== undefined
                ? {
                    postData:
                      post === null
                        ? { mimeType: mime, text: '', comment: 'left out: a sign-in or high-risk page' }
                        : { mimeType: mime, text: post },
                  }
                : {}),
              headersSize: -1,
              bodySize: req.postData != null ? Buffer.byteLength(String(req.postData)) : 0,
            },
            response: {
              status: 0,
              statusText: '',
              httpVersion: '',
              cookies: [],
              headers: [],
              content: { size: 0, mimeType: '' },
              redirectURL: '',
              headersSize: -1,
              bodySize: -1,
            },
            cache: {},
            timings: { send: 0, wait: 0, receive: 0 },
            _resourceType: String(p.type ?? '').toLowerCase(),
          },
        };
        rec.entries.set(key, entry);
        rec.order.push(key);
        return;
      }
      case 'Network.responseReceived': {
        const e = rec.entries.get(key);
        if (e) this.#response(e, p.response ?? {});
        return;
      }
      case 'Network.loadingFinished': {
        const e = rec.entries.get(key);
        if (!e) return;
        e.har.response.bodySize = p.encodedDataLength ?? -1;
        this.#finish(e, p.timestamp);
        void this.#body(rec, tab, e);
        return;
      }
      case 'Network.loadingFailed': {
        const e = rec.entries.get(key);
        if (!e) return;
        e.har.response._error = p.canceled ? 'canceled' : String(p.errorText || 'failed');
        this.#finish(e, p.timestamp);
        return;
      }
      default:
    }
  }

  #response(e, /** @type {any} */ r) {
    const res = e.har.response;
    res.status = r.status ?? 0;
    res.statusText = String(r.statusText ?? '');
    res.httpVersion = String(r.protocol ?? '').toUpperCase() || 'HTTP/1.1';
    e.har.request.httpVersion = res.httpVersion;
    res.headers = headersOf(r.headers);
    res.redirectURL = redactUrl(headerValue(r.headers, 'location'));
    res.content = { size: Number(r.encodedDataLength) || 0, mimeType: String(r.mimeType ?? '') };
    if (r.remoteIPAddress) e.har.serverIPAddress = String(r.remoteIPAddress);
    e.timing = r.timing ?? null;
  }

  #finish(e, /** @type {number} */ endS) {
    const { time, timings } = timingsOf(e.timing, e.startS, endS ?? e.startS);
    e.har.time = time;
    e.har.timings = timings;
  }

  /** The response body of a text resource of an ordinary page, within the caps. */
  async #body(/** @type {HarRecording} */ rec, tab, e) {
    const mime = e.har.response.content.mimeType;
    if (!e.open || !TEXT_MIME.test(mime) || rec.bodies >= this.maxBodies) return;
    e.pending = tab
      .send('Network.getResponseBody', { requestId: e.requestId }, e.sessionId)
      .then((/** @type {any} */ r) => {
        const text = String(r?.body ?? '');
        const size = Buffer.byteLength(text);
        if (size > this.maxBody || rec.bodies + size > this.maxBodies)
          return void (e.har.response.content.comment = 'body left out: too large');
        rec.bodies += size;
        e.har.response.content.size = r.base64Encoded ? Buffer.from(text, 'base64').length : size;
        e.har.response.content.text = text;
        if (r.base64Encoded) e.har.response.content.encoding = 'base64';
      })
      .catch((/** @type {unknown} */ error) => noteIgnored('read a response body for a HAR', error));
    await e.pending;
  }

  /** The HAR of a stopped recording, once its bodies were read. */
  async har(/** @type {HarRecording} */ rec, /** @type {string} */ version) {
    const entries = [...rec.entries.values()];
    await Promise.all(entries.map((e) => e.pending));
    entries.sort((a, b) => (a.har.startedDateTime < b.har.startedDateTime ? -1 : a.har.startedDateTime > b.har.startedDateTime ? 1 : 0));
    return {
      log: {
        version: '1.2',
        creator: { name: 'MoPilot', version },
        pages: rec.pages,
        entries: entries.map((e) => e.har),
        ...(rec.dropped ? { comment: `${rec.dropped} later requests were left out (at most ${this.maxEntries}).` } : {}),
      },
    };
  }
}

module.exports = { HarRecorder, maskPost, maskJson, headersOf, timingsOf, MAX_ENTRIES, MAX_BODY, MAX_BODIES, REDACTED };
