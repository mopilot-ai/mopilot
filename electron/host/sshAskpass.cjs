// ssh's questions answered in the app: a tiny askpass script (plain sh and nc, since the app cannot run as Node) passes each question over a private unix socket to the main process, which asks the window and returns the answer; answers are never written or logged.
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { fs } = require('../platform/ports/fs.cjs');
const { classifyPrompt } = require('./sshPrompt.cjs');

/** A question and its token never come close to this; a client that sends more is not ssh's askpass. */
const MAX_REQUEST = 64 * 1024;

/** The askpass program: the token and the question (base64, one line each) go to the app, the answer comes back base64; nothing back is a cancel. @param {string} nc */
const script = (nc) => `#!/bin/sh
# MoPilot's ssh askpass: hands ssh's question to the app and prints the answer typed there; no answer cancels.
# nc gives up when its input ends, so the input stays open (a newline now and then) until the app answers and nc exits; then the next
# newline fails (SIGPIPE may be ignored, inherited from the app) and ends the loop
r=$( { printf '%s\\n' "$MOPILOT_ASKPASS_TOKEN"; printf '%s' "$1" | base64 | tr -d '\\n'; printf '\\n'; while sleep 0.2 && echo 2>/dev/null; do :; done; } | '${nc.replace(/'/g, `'\\''`)}' -U "$MOPILOT_ASKPASS_SOCK" ) || r=''
# no answer: said on ssh's stderr, which the add card reads (shared/host/installFailure.mjs), so a declined question is not shown as a failed sign-in
[ -n "$r" ] || { echo 'MoPilot: no answer was given to ssh.' >&2; exit 1; }
printf '%s\\n' "$r" | base64 -d
`;

/**
 * @typedef {{ destination: string, pid?: number, pause?: () => void, resume?: () => void }} AskContext what one ssh run is for: its machine, the ssh process once it runs (only a process under it may ask), and `pause`/`resume` to hold its timeout while a person answers
 * @typedef {AskContext & import('./sshPrompt.cjs').SshPrompt} AskRequest
 */

/**
 * @param {object} o
 * @param {string} o.dir a private folder short enough for a unix socket path
 * @param {(q: AskRequest) => Promise<string | null>} o.ask the answer, or null to cancel
 * @param {(socket: net.Socket, root: number | undefined) => Promise<string | null>} o.verifyPeer null when the process at the socket's other end runs under `root` (the ssh this run started), else why not: the token sits in ssh's environment, which other processes of this user can read
 * @param {string} [o.nc] the netcat that speaks unix sockets
 */
function createAskpass({ dir, ask, verifyPeer, nc = '/usr/bin/nc' }) {
  const file = path.join(dir, 'askpass.sh');
  const sock = path.join(dir, 'askpass.sock');
  /** The runs that may ask, by their token. @type {Map<string, AskContext>} */
  const runs = new Map();
  /** @type {net.Server | null} */
  let server = null;
  /** @type {Promise<void> | null} */
  let ready = null;

  /** @param {net.Socket} conn */
  const serve = (conn) => {
    let buf = '';
    let done = false;
    conn.on('error', () => undefined);
    conn.on('data', (chunk) => {
      if (done) return;
      buf += chunk.toString('utf8');
      if (buf.length > MAX_REQUEST) return conn.destroy();
      const lines = buf.split('\n');
      if (lines.length < 3) return;
      done = true;
      const ctx = runs.get(lines[0]);
      if (!ctx) return void conn.end('\n');
      const question = Buffer.from(lines[1], 'base64').toString('utf8');
      ctx.pause?.();
      verifyPeer(conn, ctx.pid)
        .then((refused) => (refused ? null : ask({ ...ctx, ...classifyPrompt(question) })))
        .then(
          (answer) => conn.end(typeof answer === 'string' ? `${Buffer.from(answer, 'utf8').toString('base64')}\n` : '\n'),
          () => conn.end('\n'),
        )
        .finally(() => ctx.resume?.());
    });
  };

  const start = () =>
    (ready ??= new Promise((resolve, reject) => {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      fs.writeFileSync(file, script(nc), { mode: 0o700 });
      fs.chmodSync(file, 0o700);
      fs.rmSync(sock, { force: true });
      const s = net.createServer(serve);
      s.once('error', (e) => {
        ready = null;
        reject(e);
      });
      s.listen(sock, () => {
        fs.chmodSync(sock, 0o600);
        server = s;
        resolve();
      });
    }));

  return {
    /** The environment that lets one ssh run ask through the app, and the call that ends its right to ask. @param {AskContext} context */
    async env(context) {
      await start();
      const token = crypto.randomBytes(16).toString('hex');
      runs.set(token, context);
      return {
        env: { SSH_ASKPASS: file, SSH_ASKPASS_REQUIRE: 'force', MOPILOT_ASKPASS_SOCK: sock, MOPILOT_ASKPASS_TOKEN: token },
        release: () => void runs.delete(token),
      };
    },
    close() {
      runs.clear();
      server?.close();
      server = null;
      ready = null;
      fs.rmSync(sock, { force: true });
    },
  };
}

module.exports = { createAskpass };
