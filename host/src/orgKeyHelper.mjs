// Claude Code's key helper for an organization lease (#3361 Tier 2): a CLI the Host started runs `apiKeyHelper` (./orgKeyHelperBin.mjs) to ask for the lease's token over a socket in the Host's own owner-only folder, so a token the app renewed reaches a turn that is already running with no restart, and the token is never in the CLI's env, its argv or a file. The socket answers only a caller that knows a capability this Host process minted, which only its own children are given; each capability is bound to the org identity its CLI was started for, so a CLI never reads another identity's token.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** How often Claude Code asks the helper again, at most: a renewed token is used within this. */
export const HELPER_TTL_MS = 5 * 60_000;
/** How often it asks at least: a helper run per few seconds would be its own load. */
export const HELPER_TTL_MIN_MS = 10_000;

/**
 * How often a CLI started with a lease of `lifeMs` left asks again: a tenth of its life, within bounds, so the renewal (at 80% of the life)
 * reaches it well before the old token ends, even for an IdP whose tokens last minutes. @param {number} lifeMs
 */
export const helperTtl = (lifeMs) => Math.round(Math.min(HELPER_TTL_MS, Math.max(HELPER_TTL_MIN_MS, lifeMs / 10)));
/** The env names a CLI started with the helper is given; none of them is the token. */
export const HELPER_ENV = Object.freeze({
  socket: 'MOPILOT_ORG_KEY_SOCKET',
  cap: 'MOPILOT_ORG_KEY_CAP',
  ttl: 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
});
const BIN = fileURLToPath(new URL('./orgKeyHelperBin.mjs', import.meta.url));
/** The longest line a caller may send before it is cut off. */
const MAX_LINE = 256;

/**
 * @param {object} o
 * @param {string} o.dir the Host's owner-only socket folder (./paths.mjs ensureSocketDir)
 * @param {(harness: string, identity: string) => { token: string } | null} o.leaseOf that identity's lease for the harness now (./credentialLease.mjs orgLease)
 * @param {string} [o.node] the node that runs the helper (this one)
 * @param {(n: number) => Buffer} [o.randomBytes]
 */
export function createOrgKeyHelper({ dir, leaseOf, node = process.execPath, randomBytes = crypto.randomBytes }) {
  /** @type {Map<string, string>} each capability's identity, and back */
  const identityOf = new Map();
  /** @type {Map<string, string>} */
  const capOf = new Map();
  /** @param {string} identity */
  const capFor = (identity) => {
    let cap = capOf.get(identity);
    if (!cap) {
      cap = randomBytes(32).toString('hex');
      capOf.set(identity, cap);
      identityOf.set(cap, identity);
    }
    return cap;
  };
  const socketPath = path.join(dir, `org-key-${process.pid}.sock`);
  /** @type {net.Server | null} */
  let server = null;
  /** @type {Promise<void> | null} */
  let listening = null;
  /** @param {net.Socket} socket */
  const serve = (socket) => {
    let line = '';
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk) => {
      line += chunk;
      if (line.length > MAX_LINE) return void socket.destroy();
      const end = line.indexOf('\n');
      if (end < 0) return;
      const given = Buffer.from(line.slice(0, end));
      // compared in constant time against each capability minted (one per identity on this Host)
      /** @type {string | null} */
      let identity = null;
      for (const [cap, who] of identityOf)
        if (given.length === cap.length && crypto.timingSafeEqual(given, Buffer.from(cap))) identity = who;
      const token = identity ? (leaseOf('claude', identity)?.token ?? null) : null;
      // a wrong capability and no lease read the same to the caller
      socket.end(token ? `${token}\n` : '\n');
    });
  };
  return {
    /** Opens the socket once, when a CLI first needs it. */
    listen() {
      listening ??= new Promise((resolve, reject) => {
        // a Host killed hard with this pid left its socket: the folder is this user's own, so the name is ours to take
        fs.rmSync(socketPath, { force: true });
        server = net.createServer(serve);
        server.once('error', reject);
        server.listen(socketPath, () => resolve());
      });
      return listening;
    },
    /** What a CLI started for `identity` with a lease of `lifeMs` left gets in its env: where to ask, that identity's capability and how often, never the token. @param {string} identity @param {number} lifeMs */
    env: (identity, lifeMs) => ({
      [HELPER_ENV.socket]: socketPath,
      [HELPER_ENV.cap]: capFor(identity),
      [HELPER_ENV.ttl]: String(helperTtl(lifeMs)),
    }),
    /** The command Claude Code's `apiKeyHelper` setting runs. */
    command: `${JSON.stringify(node)} ${JSON.stringify(BIN)}`,
    close() {
      server?.close();
      server = null;
      listening = null;
    },
  };
}

/**
 * The SDK's arguments with the helper set: merged into the `--settings` JSON the SDK passes, or a `--settings` of its own when there is none.
 * @param {string[]} args @param {string} command
 */
export function withKeyHelper(args, command) {
  const at = args.indexOf('--settings');
  if (at >= 0 && at + 1 < args.length) {
    try {
      const parsed = JSON.parse(args[at + 1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out = [...args];
        out[at + 1] = JSON.stringify({ ...parsed, apiKeyHelper: command });
        return out;
      }
    } catch {
      // a settings file path: a second --settings carries the helper
    }
  }
  return [...args, '--settings', JSON.stringify({ apiKeyHelper: command })];
}

/**
 * What the helper does when Claude Code runs it: asks the Host for the token and prints it, or fails without printing anything.
 * @param {{ env: NodeJS.ProcessEnv, stdout: { write: (s: string) => unknown }, connect?: typeof net.connect }} o
 * @returns {Promise<number>} the exit code
 */
export function printKey({ env, stdout, connect = net.connect }) {
  const socketPath = env[HELPER_ENV.socket];
  const cap = env[HELPER_ENV.cap];
  if (!socketPath || !cap) return Promise.resolve(2);
  return new Promise((resolve) => {
    let reply = '';
    const socket = connect(socketPath);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${cap}\n`));
    socket.on('data', (chunk) => {
      reply += chunk;
    });
    socket.on('error', () => resolve(1));
    socket.on('close', () => {
      const token = reply.split('\n')[0];
      if (!token) return resolve(1);
      stdout.write(token);
      resolve(0);
    });
  });
}
