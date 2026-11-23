// `mopilot-host enroll` (Add by command, #2709): the far machine joins the user's app through the relay. It reads its input, one JSON
// line { relayUrl, hostId, secret, pairId, code }, from standard input only (never from the command line, so the code is in no argv,
// log or file this program writes), dials the relay with the credential the app issued, sends its hello sealed under the code
// (shared/host/relayEnroll.mjs): fresh X25519 keys, the machine's name, system, architecture and user, its socket, its id and a
// one-time pairing code for the app; and waits for the app's answer. Allowed, it keeps the enrollment in `relay.json` (relayLink.mjs)
// and the service it is installed as dials the relay with it from then on; refused or cancelled, it keeps nothing.
import os from 'node:os';
import { createRequire } from 'node:module';
import { createCrypto } from '../../shared/remote/crypto.mjs';
import { fromBase64, toBase64 } from '../../shared/remote/envelope.mjs';
import { createNodePrimitives } from '../../shared/remote/nodePrimitives.mjs';
import { CODE, enrollKeys, openEnroll, sealEnroll } from '../../shared/host/relayEnroll.mjs';
import { APP_ID, keepEnrollment } from './relayLink.mjs';

const require = createRequire(import.meta.url);
const { RelayClient } = require('../../electron/remote/relayClient.cjs');

/** How long the machine waits for the user to allow it (the app's command lives 15 minutes). */
export const WAIT_MS = 15 * 60_000;

export class EnrollError extends Error {
  /** @param {'input' | 'denied' | 'cancelled' | 'timeout'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const HOST = /^h_[A-Za-z0-9_-]{16,64}$/;
const SECRET = /^[A-Za-z0-9_-]{43,128}$/;
const PAIR = /^p_[A-Za-z0-9_-]{8,64}$/;
const URL_RE = /^wss:\/\/[^\s/?#]+\/[^\s#]*$|^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/[^\s#]*$/;

/** The input line, checked; a bad one says what is wrong without repeating it (it holds the credential and the code). @param {string} text */
export function parseInput(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    throw new EnrollError('input', 'Run the whole command MoPilot showed.');
  }
  const ok =
    v &&
    typeof v.relayUrl === 'string' &&
    URL_RE.test(v.relayUrl) &&
    HOST.test(String(v.hostId)) &&
    SECRET.test(String(v.secret)) &&
    PAIR.test(String(v.pairId)) &&
    CODE.test(String(v.code));
  if (!ok) throw new EnrollError('input', 'Run the whole command MoPilot showed.');
  return /** @type {{ relayUrl: string, hostId: string, secret: string, pairId: string, code: string }} */ (v);
}

/**
 * @param {object} o
 * @param {ReturnType<typeof parseInput>} o.input
 * @param {string} o.configDir
 * @param {string} o.socketPath this Host's socket, which the app keeps on its record
 * @param {{ issueCode: () => string, hostId: () => string }} o.pairing this Host's pairing (pairing.mjs)
 * @param {(line: string) => void} [o.say] progress for the person at the terminal (never the code or the credential)
 * @param {import('../../shared/remote/crypto.mjs').Primitives} [o.prim]
 * @param {(url: string, headers: Record<string, string>) => any} [o.createSocket]
 * @param {number} [o.waitMs]
 * @param {{ hostname: () => string, platform: () => string, arch: () => string, user: () => string }} [o.machine]
 * @returns {Promise<{ hostId: string }>}
 */
export function enroll({
  input,
  configDir,
  socketPath,
  pairing,
  say = () => undefined,
  prim = createNodePrimitives(),
  createSocket = (url, headers) => new /** @type {any} */ (globalThis.WebSocket)(url, { headers }),
  waitMs = WAIT_MS,
  machine = { hostname: () => os.hostname(), platform: () => os.platform(), arch: () => os.arch(), user: () => os.userInfo().username },
}) {
  const c = createCrypto(prim);
  const keys = enrollKeys(c, input.code, input.pairId);
  const sk = prim.randomBytes(32);
  const ephSk = prim.randomBytes(32);
  const hello = sealEnroll(prim, keys.p2m, input.pairId, 'p2m', {
    v: 1,
    hostPub: toBase64(prim.x25519Base(sk)),
    hostEphPub: toBase64(prim.x25519Base(ephSk)),
    name: machine.hostname(),
    os: machine.platform(),
    arch: machine.arch(),
    user: machine.user(),
    socketPath,
    hostKey: pairing.hostId(),
    pairingCode: pairing.issueCode(),
  });
  const relay = new RelayClient({
    url: () => input.relayUrl,
    getToken: async () => `mh1.${input.hostId}.${input.secret}`,
    createSocket,
  });
  return new Promise((resolve, reject) => {
    // relay.stop() ends every event of the socket at once, so this runs once
    const finish = (/** @type {Error | null} */ error, /** @type {any} */ value) => {
      clearTimeout(timer);
      relay.stop();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new EnrollError('timeout', 'MoPilot did not allow this machine in time. Make a new command and run it again.'), null),
      waitMs,
    );
    // the hello goes on every open and whenever the app comes (back) to the relay: it may not have been there to hear it
    const send = () => relay.state === 'open' && relay.sendFrame(hello);
    relay.on('open', () => {
      say('Waiting for MoPilot on your Mac to allow this machine…');
      send();
    });
    relay.on('event', (/** @type {any} */ e) => {
      if (e?.ev === 'peer' && e.online === true) send();
    });
    relay.on('state', (/** @type {string} */ s) => {
      if (s === 'revoked') finish(new EnrollError('cancelled', 'This command was cancelled in MoPilot.'), null);
    });
    relay.on('frame', (/** @type {any} */ f) => {
      // a frame sealed under anything but the code's app key (its direction is in what the seal covers) opens to nothing
      const answer = openEnroll(prim, keys.m2p, f);
      if (!answer) return;
      if (answer.allow !== true) return finish(new EnrollError('denied', 'MoPilot did not allow this machine.'), null);
      try {
        const root = c.deriveRoot(sk, fromBase64(answer.appPub), ephSk, fromBase64(answer.appEphPub), APP_ID, input.hostId, input.pairId);
        keepEnrollment(configDir, {
          relayUrl: input.relayUrl,
          hostId: input.hostId,
          secret: input.secret,
          pairId: input.pairId,
          root: toBase64(root),
        });
      } catch {
        return finish(new EnrollError('denied', 'MoPilot sent an answer this machine cannot use.'), null);
      }
      finish(null, { hostId: input.hostId });
    });
    relay.start();
  });
}
