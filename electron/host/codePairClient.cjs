// Pairing another Mac by a code, the controlling side (R2b, #5576): `addByCode(code)` parses what was typed (a typo burns nothing), finds out that the relay offers the service, claims the offer, runs the initiator of shared/host/codePair.mjs over the relay's rendezvous, mints and registers the relay credential as for an ssh-added machine and seals it in m3, waits for the other Mac's answer, and adds the machine. EVERY failure ends the run, revokes the credential (safe to repeat; the lane keeps it on the revoke list until the relay answers) and says its cause and the fix in place; a failed run is never retried with the same code.
const { fs } = require('../platform/ports/fs.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { writePrivate } = require('../platform/fsutil.cjs');
const { parseCode, CodePairError, b64u, createInitiator } = require('../../shared/host/codePair.mjs');
const nodeCrypto = require('node:crypto');
const { toBase64, fromBase64 } = require('../../shared/remote/envelope.mjs');
const { parseParams } = require('../../shared/host/schema.mjs');
const { createTypedCodeBudgets } = require('./codePairBudgets.cjs');

/** How long the other Mac has to answer after the credential is sent, and to reply to the first message. */
const ANSWER_MS = 2 * 60_000;
const REPLY_MS = 30_000;
/** One request to the relay. */
const REQUEST_MS = 10_000;
// the offer stays open about 30 seconds after the controlled Mac answers: its answer is read at least twice a second
const POLL_MS = 400;
/** The app's id in every enrollment's root (host/src/relayLink.mjs APP_ID). */
const APP_ID = 'app';
/** A 32-byte public key in base64. */
const KEY = /^[A-Za-z0-9+/]{43}=$/;
const ROUTE = '/v1/rendezvous';

/**
 * What each ending says, and the fix offered in place: `fix` is a button the dialog draws (`enter_code`: type another code, `retry`: the same try again, nothing was spent).
 * @type {Record<string, { cause: (name: string) => string, fix: { id: string, label: string } | null }>}
 */
const FAILURES = {
  bad_code: {
    cause: () => "That code didn't work. Check it on the other Mac, or get a new one.",
    fix: { id: 'enter_code', label: 'Enter another code' },
  },
  denied: { cause: (name) => `${name} didn't allow it.`, fix: { id: 'enter_code', label: 'Use a new code' } },
  timeout: { cause: (name) => `${name} didn't answer in time. Ask it to try again.`, fix: { id: 'enter_code', label: 'Use a new code' } },
  unreachable: { cause: () => "Couldn't reach MoPilot's relay. Check your connection.", fix: { id: 'retry', label: 'Try again' } },
  unreachable_late: {
    cause: () => "Couldn't reach MoPilot's relay. Check your connection.",
    fix: { id: 'enter_code', label: 'Use a new code' },
  },
  spent: {
    cause: () => 'This code can’t be used again. Get a new one from the other Mac.',
    fix: { id: 'enter_code', label: 'Enter another code' },
  },
  off: { cause: () => "Pairing by code isn't available yet.", fix: null },
  busy: { cause: () => 'Another pairing is running. Wait for it to end.', fix: { id: 'retry', label: 'Try again' } },
  limited: { cause: () => 'Too many tries. Wait a minute, then try again.', fix: { id: 'retry', label: 'Try again' } },
  unrecorded: { cause: () => "Couldn't save this attempt. Try again.", fix: { id: 'retry', label: 'Try again' } },
  cancelled: { cause: () => 'Pairing was cancelled.', fix: { id: 'enter_code', label: 'Use a new code' } },
  failed: { cause: () => 'Pairing did not work. Get a new code from the other Mac.', fix: { id: 'enter_code', label: 'Use a new code' } },
};

/** What a run stopped by the protocol says (any other protocol error reads as a code that did not work). @type {Record<string, string>} */
const FROM_PROTOCOL = { burned: 'spent', unrecorded: 'unrecorded' };

/** The relay's HTTP origin for its WebSocket URL. @param {string} wsUrl */
const httpBase = (wsUrl) => {
  const u = new URL(wsUrl);
  return `${u.protocol === 'ws:' ? 'http:' : 'https:'}//${u.host}`;
};

/** A run that ended: said with its cause and fix. @param {string} code @param {string} [name] */
const failure = (code, name = 'The other Mac') => {
  const f = FAILURES[code] ?? FAILURES.failed;
  return { ok: /** @type {const} */ (false), code, cause: f.cause(name), fix: f.fix };
};

/** The most of a relay's answer that is read: a read holds at most six boxes of 2800 characters. */
const MAX_ANSWER = 24 * 1024;
const MAX_MESSAGES = 6;
const MAX_BOX = 2800;

/** What the relay answered, or null for nothing or for what is not JSON; an answer past the bound is an error (the relay is not one to be trusted with memory). @param {Response} res */
async function jsonOf(res) {
  if (res.status === 204) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (/** @type {unknown} */ (res.body ?? []))) {
    size += chunk.length;
    if (size > MAX_ANSWER) throw new Error('The relay answered with more than a pairing message can be.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    noteIgnored('read the relay’s answer to a pairing request', error);
    return null;
  }
}

/** @param {number} ms @param {AbortSignal} [signal] */
const sleepFor = (ms, signal) =>
  new Promise((resolve) => {
    const done = () => (clearTimeout(t), signal?.removeEventListener('abort', done), resolve(undefined));
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

/**
 * @param {object} o
 * @param {ReturnType<typeof import('../../shared/remote/crypto.mjs').createCrypto>} o.crypto
 * @param {() => boolean} o.enabled the flag `host.codePair`
 * @param {() => string | null} o.relayUrl the relay's WebSocket URL; null when this build names none
 * @param {() => { pub: Uint8Array, name: string, sign: (m: Uint8Array) => Uint8Array }} o.device this Mac's identity and name
 * @param {ReturnType<typeof import('./relayLane.cjs').createRelayLane>} o.lane
 * @param {{ adopt: (destination: string, e: object, opts?: object) => void, forget: (destination: string) => Promise<boolean> }} o.paths
 * @param {(m: { id: string, name: string, address: string, peerDevice: string }) => void} o.addMachine
 * @param {{ read: () => unknown, write: (v: unknown) => void, setAside: () => void }} o.store the typed-code budgets' file
 * @param {typeof fetch} [o.fetch] @param {() => number} [o.now] @param {{ answerMs?: number, replyMs?: number, pollMs?: number }} [o.timing]
 * @param {(event: { state: string, safety?: string, name?: string }) => void} [o.onProgress] what the dialog shows while it runs (the words to compare, then the name asked)
 */
function createCodePairClient({
  crypto: c,
  enabled,
  relayUrl,
  device,
  lane,
  paths,
  addMachine,
  store,
  fetch: doFetch = fetch,
  now = Date.now,
  timing = {},
  onProgress = () => undefined,
}) {
  const { answerMs = ANSWER_MS, replyMs = REPLY_MS, pollMs = POLL_MS } = timing;
  const budgets = createTypedCodeBudgets({ store, now });
  /** @type {AbortController | null} */
  let running = null;

  /** One JSON request to the relay: its status and body, or null when it could not be reached. @param {string} base @param {string} path @param {object} body @param {AbortSignal} signal */
  async function post(base, path, body, signal) {
    try {
      const res = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]),
      });
      return { status: res.status, json: await jsonOf(res) };
    } catch {
      return null;
    }
  }

  /** The next message of the other Mac after `after`, waiting up to `ms`: its text, or why not. @param {string} base @param {string} id @param {string} ticket @param {number} after @param {number} ms @param {AbortSignal} signal */
  async function nextMessage(base, id, ticket, after, ms, signal) {
    const until = now() + ms;
    for (;;) {
      const got = await post(base, `${ROUTE}/${id}/read`, { ticket, after }, signal);
      if (signal.aborted) return { why: /** @type {const} */ ('cancelled') };
      if (!got) return { why: /** @type {const} */ ('unreachable') };
      if (got.status === 404) return { why: /** @type {const} */ ('gone') };
      const all = got.status === 200 ? got.json?.messages : null;
      // more than a run has, or a box longer than the relay allows, is not the relay of this protocol
      if (Array.isArray(all) && (all.length > MAX_MESSAGES || all.some((m) => typeof m?.box === 'string' && m.box.length > MAX_BOX)))
        return { why: /** @type {const} */ ('bad') };
      const message = Array.isArray(all) ? all[0] : null;
      if (message && typeof message.box === 'string') return { box: message.box, n: Number(message.n) };
      if (now() >= until) return { why: /** @type {const} */ ('timeout') };
      await sleepFor(pollMs, signal);
    }
  }

  /** @param {string} text */
  async function addByCode(text) {
    if (!enabled()) return failure('off');
    const code = parseCode(text);
    // what is no code at all burns nothing and is not counted anywhere
    if (!code) return failure('bad_code');
    if (running) return failure('busy');
    const wsUrl = relayUrl();
    if (!wsUrl) return failure('off');
    // whatever ends the run, even a throw out of it, the next one may start
    return runWith(new AbortController(), wsUrl, code).finally(() => {
      running = null;
    });
  }

  /** One run, whose every ending is an answer. @param {AbortController} control @param {string} wsUrl @param {{ hint: string, secret: string }} code */
  async function runWith(control, wsUrl, code) {
    running = control;
    const base = httpBase(wsUrl);
    /** @type {{ id: string, ticket: string } | null} */
    let offer = null;
    /** @type {{ hostId: string, pairId: string } | null} */
    let credential = null;
    let begun = false;
    let peerName = '';
    /** Ends the run: the offer is closed and the credential revoked (each is safe to repeat). @param {string} reason */
    const end = async (reason) => {
      if (offer) await post(base, `${ROUTE}/${offer.id}/close`, { ticket: offer.ticket }, new AbortController().signal);
      // in a function of its own so that a revoke that throws at once (a disk error writing the revoke list) is a rejection too: the credential stays on the list the lane kept before it was registered
      if (credential)
        await (async () => lane.revoke(/** @type {{ hostId: string }} */ (credential).hostId))().catch((e) =>
          noteIgnored('revoke a pairing credential', e),
        );
      const why = control.signal.aborted ? 'cancelled' : reason === 'unreachable' && begun ? 'unreachable_late' : reason;
      return failure(why, peerName || undefined);
    };
    try {
      // a code that has had its runs is refused before the relay is asked anything
      const budget = budgets.forCode(code);
      if (budget.burned) return await end('spent');
      // the relay offers the service, or its claim route is unknown (a GET is a probe that costs nothing: 405 when on, 404 when off)
      let probe;
      try {
        probe = await doFetch(`${base}${ROUTE}/claim`, { method: 'GET', signal: AbortSignal.timeout(REQUEST_MS) });
      } catch {
        return await end('unreachable');
      }
      if (probe.status === 404) return await end('off');
      if (probe.status !== 405) return await end('unreachable');
      const claimed = await post(base, `${ROUTE}/claim`, { hint: code.hint }, control.signal);
      if (!claimed) return await end('unreachable');
      if (claimed.status === 429) return await end('limited');
      const j = claimed.json;
      if (claimed.status !== 200 || typeof j?.id !== 'string' || typeof j.ticket !== 'string' || !Number.isInteger(j.claims))
        return await end('bad_code');
      offer = { id: j.id, ticket: j.ticket };
      const me = device();
      const initiator = createInitiator({
        crypto: c,
        secret: code.secret,
        hint: code.hint,
        rendezvousId: j.id,
        claims: j.claims,
        device: me,
        budget,
      });
      const m1 = initiator.first();
      begun = true;
      const sent1 = await post(base, `${ROUTE}/${j.id}/send`, { ticket: j.ticket, claims: j.claims, box: m1 }, control.signal);
      if (!sent1 || sent1.status !== 200) return await end(sent1 ? 'bad_code' : 'unreachable');
      const m2 = await nextMessage(base, j.id, j.ticket, 0, replyMs, control.signal);
      // no first reply reads as a wrong code: "didn't answer in time" would tell that an offer with this hint is live
      if (!('box' in m2))
        return await end(
          /** @type {Record<string, string>} */ ({ unreachable: 'unreachable', cancelled: 'cancelled', bad: 'failed' })[m2.why] ??
            'bad_code',
        );
      // the code proved itself (the other Mac's tag): only now does anything of this Mac's get made
      initiator.verify(m2.box);
      onProgress({ state: 'safety', safety: /** @type {string} */ (initiator.safety) });
      const relay = wsUrl;
      const hostId = `h_${b64u(c.prim.randomBytes(16))}`;
      const pairId = `p_${b64u(c.prim.randomBytes(12))}`;
      const secret = b64u(c.prim.randomBytes(32));
      // this app's half of the relay pair: fresh keys for it, as a phone's enrollment makes, whose public halves travel sealed in m3
      const sk = c.prim.randomBytes(32);
      const ephSk = c.prim.randomBytes(32);
      const carry = {
        relayUrl: relay,
        hostId,
        secret,
        pairId,
        appPub: toBase64(c.prim.x25519Base(sk)),
        appEphPub: toBase64(c.prim.x25519Base(ephSk)),
      };
      // the Host judges it with the same parser: what it would refuse is not sent
      parseParams('host.relayEnroll', carry);
      credential = { hostId, pairId };
      await lane.whenOpen();
      // on the revoke list from before the relay has it, until it is kept: a crash here leaves nothing behind (the lane sends the list on every open)
      lane.intend(hostId);
      await lane.register({ host: hostId, pair: pairId, hash: nodeCrypto.createHash('sha256').update(secret).digest('hex') });
      const m3 = initiator.seal(carry);
      const sent3 = await post(base, `${ROUTE}/${j.id}/send`, { ticket: j.ticket, claims: j.claims, box: m3 }, control.signal);
      if (!sent3 || sent3.status !== 200) return await end(sent3 ? 'failed' : 'unreachable');
      onProgress({ state: 'waiting' });
      const m4 = await nextMessage(base, j.id, j.ticket, /** @type {number} */ (m2.n), answerMs, control.signal);
      if (!('box' in m4)) return await end(m4.why === 'gone' ? 'timeout' : m4.why === 'bad' ? 'failed' : m4.why);
      const done = initiator.finish(m4.box);
      if (done.denied) return await end('denied');
      peerName = done.peerName;
      // the Host's half of the pair, from the sealed answer: nothing else is a machine this app can reach
      const half = /** @type {any} */ (done.carry);
      if (!KEY.test(String(half?.hostPub)) || !KEY.test(String(half?.hostEphPub))) return await end('failed');
      const root = c.deriveRoot(sk, fromBase64(half.hostPub), ephSk, fromBase64(half.hostEphPub), APP_ID, hostId, pairId);
      const id = `relay:${hostId}`;
      paths.adopt(id, { hostId, pairId, relayUrl: relay, root: toBase64(root) }, { rotate: false });
      try {
        addMachine({ id, name: done.peerName, address: id, peerDevice: b64u(done.peerDevice) });
      } catch (error) {
        // a machine that cannot be listed is not paired: its path and credential go with it
        await paths.forget(id).catch((e) => noteIgnored('forget a machine that was not listed', e));
        throw error;
      }
      lane.settle(hostId);
      credential = null;
      await post(base, `${ROUTE}/${j.id}/close`, { ticket: j.ticket }, new AbortController().signal);
      return { ok: /** @type {const} */ (true), id, name: done.peerName, safety: done.safety };
    } catch (error) {
      if (error instanceof CodePairError) return await end(FROM_PROTOCOL[error.code] ?? 'bad_code');
      noteIgnored('pair a machine by code', error);
      return await end('failed');
    }
  }

  return {
    addByCode,
    /** The person closed the dialog: the run ends now and its credential goes. */
    cancel: () => running?.abort(),
    /** Forgets what ran out of its ten minutes. */
    sweep: () => budgets.sweep(),
  };
}

/** The typed-code budgets' file: JSON in the app's data folder. @param {string} file */
const fileStore = (file) => ({
  read() {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') return undefined;
      throw error;
    }
  },
  write(value) {
    writePrivate(file, JSON.stringify(value));
  },
  /** A file that cannot be trusted is moved aside, never deleted. */
  setAside() {
    fs.renameSync(file, `${file}.corrupt-${nodeCrypto.randomUUID()}`);
  },
});

module.exports = { createCodePairClient, fileStore, sleepFor, failure, FAILURES, ANSWER_MS };
