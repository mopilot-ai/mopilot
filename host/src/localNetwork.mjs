// Whether this Host may reach the local network. macOS asks before a program performs a local network operation (Local Network
// privacy, Apple TN3179); a Host that launchd started as the user's agent and that was never allowed, or whose alert nobody has
// answered yet, is refused at once with "no route to host" (EHOSTUNREACH), while the internet (the relay, the agents' APIs) works.
// The check sends one empty datagram to the all-hosts multicast group's discard port: every multicast address is local network, it
// needs no other machine to exist, and nothing answers it. The router is no test: traffic to the DNS server is exempt, and on most
// networks the router is the DNS server (seen on a never-allowed VM: the router took the connection, multicast was refused).
// Only a Host run as a service is asked: one started from a terminal has the terminal's grant, and no test sends to a real network.
import dgram from 'node:dgram';

/** How long the answer is kept: a grant given meanwhile shows within a minute. */
const KEEP_MS = 60_000;
/** All hosts on this network, discard port: a local network address no program listens on. */
const GROUP = '224.0.0.1';
const DISCARD = 9;

/** @typedef {'allowed' | 'denied' | 'unknown'} LocalNetwork */

/**
 * One empty datagram to the all-hosts group: 'sent' when the system sent it, 'no-route' when it refused to (the Local Network
 * denial), '' for any other failure (no network, no multicast route).
 * @param {{ createSocket?: typeof dgram.createSocket }} [o]
 * @returns {Promise<'sent' | 'no-route' | ''>}
 */
export function knock({ createSocket = dgram.createSocket } = {}) {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    let ended = false;
    /** @param {'sent' | 'no-route' | ''} r */
    const done = (r) => {
      // the send's callback and the socket's error may both come; the first says it
      if (ended) return;
      ended = true;
      socket.close();
      resolve(r);
    };
    socket.once('error', () => done(''));
    socket.send(Buffer.alloc(0), DISCARD, GROUP, (/** @type {NodeJS.ErrnoException | null} */ e) =>
      done(!e ? 'sent' : e.code === 'EHOSTUNREACH' ? 'no-route' : ''),
    );
  });
}

/**
 * @param {object} [o]
 * @param {NodeJS.Platform} [o.platform]
 * @param {boolean} [o.supervised] whether the Host runs as the user's service (MOPILOT_HOST_SUPERVISED); otherwise the answer is 'unknown'
 * @param {() => Promise<'sent' | 'no-route' | ''>} [o.knock]
 * @param {() => number} [o.now]
 * @returns {() => Promise<LocalNetwork>} the answer, kept for a minute; calls while one is asked join it
 */
export function createLocalNetworkCheck({ platform = process.platform, supervised = true, knock: knockOn = knock, now = Date.now } = {}) {
  /** @type {{ at: number, answer: Promise<LocalNetwork> } | null} */
  let kept = null;
  async function ask() {
    // only macOS guards the local network per program
    if (platform !== 'darwin') return 'allowed';
    if (!supervised) return 'unknown';
    const r = await knockOn();
    return r === 'sent' ? 'allowed' : r === 'no-route' ? 'denied' : 'unknown';
  }
  return () => {
    if (!kept || now() - kept.at >= KEEP_MS) kept = { at: now(), answer: ask() };
    return kept.answer;
  };
}
