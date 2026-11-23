// The $BROWSER shim (IAB-02): CLIs that MoPilot starts (harnesses, the commands their agents run,
// terminals, preview servers) get BROWSER pointing at a small script, so a URL they would open in the
// system browser (vite --open, gh ... --web, a Python webbrowser call) opens in the chat's browser pane.
//
// - The script talks to main over a unix socket of its own (an HTTP server, 0600 in a 0700 folder) with
//   a token: a chat's own token routes to that chat; the shared token (harness processes that serve
//   several chats: Codex's app-server, an ACP agent) routes to the chat whose turn is running in the
//   folder the command ran in, or the only running one. Anything it can't place opens as before.
// - Opening follows the browser's site permission (paneOpener): a site the chat hasn't allowed asks
//   first; a "no", a non-http URL or no window falls back to the user's own BROWSER, else the system
//   opener (open / xdg-open), so nothing a CLI opens is ever dropped.
// - The script is a sh/JavaScript polyglot named *.js: vite runs a BROWSER ending in .js with node,
//   everything else executes it with /bin/sh. It needs curl (shipped with macOS); without it, or on
//   Windows (no shim), URLs open in the system browser as before.
const { noteIgnored } = require('../../ignored.cjs');
const crypto = require('node:crypto');
const { fs } = require('../../platform/ports/fs.cjs');
const http = require('node:http');
const path = require('node:path');
const { originOf } = require('./origins.cjs');
const { PrivateSocketListener } = require('../../platform/privateSocket.cjs');
const { SCRIPT_NAME } = require('../../platform/browserEnv.cjs');

const SH_NAME = 'mopilot-browser.sh';
const MAX_BODY = 16 * 1024;

/** The sh half: posts the URL to main, else hands it to the user's BROWSER or the system opener. */
const SH_SOURCE = `#!/bin/sh
# MoPilot: opens a URL from a command-line tool in the chat's browser pane.
# The URL is the last argument that has a scheme (vite passes its own flags first), else the last one.
url=""
for a in "$@"; do case "$a" in *://*) url="$a" ;; esac; done
if [ -z "$url" ]; then for a in "$@"; do url="$a"; done; fi
if [ -n "$url" ] && [ -n "$MOPILOT_BROWSER_SOCK" ] && [ -S "$MOPILOT_BROWSER_SOCK" ] && command -v curl >/dev/null 2>&1; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 300 --unix-socket "$MOPILOT_BROWSER_SOCK" \\
    -H "X-MoPilot-Token: $MOPILOT_BROWSER_TOKEN" --data-urlencode "url=$url" --data-urlencode "cwd=$PWD" http://mopilot/open)
  [ "$code" = "200" ] && exit 0
fi
[ -n "$url" ] || exit 1
if [ -n "$MOPILOT_BROWSER_FALLBACK" ]; then
  BROWSER= exec $MOPILOT_BROWSER_FALLBACK "$url"
fi
if [ "$(uname)" = "Darwin" ]; then exec /usr/bin/open "$url"; fi
if command -v xdg-open >/dev/null 2>&1; then BROWSER= exec xdg-open "$url"; fi
exit 1
`;

/** The polyglot: sh runs line 2 (//bin/sh is /bin/sh), node skips both lines as a shebang and a comment. */
const JS_SOURCE = `#!/bin/sh
//bin/sh "$(dirname "$0")/${SH_NAME}" "$@"; exit $?
// MoPilot: run by node (vite runs a BROWSER ending in .js that way): hand the URL to the sh half.
import('node:child_process').then(({ spawnSync }) => {
  const sh = process.argv[1].replace(/[^/\\\\]*$/, '${SH_NAME}');
  const r = spawnSync('/bin/sh', [sh, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
});
`;

/** Writes the two scripts (executable) into `dir`; returns the BROWSER path. */
function writeShim(dir, { fsm = fs } = {}) {
  fsm.mkdirSync(dir, { recursive: true });
  const sh = path.join(dir, SH_NAME);
  const js = path.join(dir, SCRIPT_NAME);
  fsm.writeFileSync(sh, SH_SOURCE, { mode: 0o755 });
  fsm.writeFileSync(js, JS_SOURCE, { mode: 0o755 });
  // an existing file keeps its old mode through writeFileSync
  fsm.chmodSync(sh, 0o755);
  fsm.chmodSync(js, 0o755);
  return js;
}

/** Whether `child` is `dir` or inside it. */
const within = (child, dir) => {
  const rel = path.relative(dir, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * The chat a shared-token request belongs to: among chats with a running turn, the one whose project
 * folder holds `cwd` (the deepest), else the only running chat; null when it can't tell.
 * @param {{ chatId: string, cwd: string | null }[]} running
 */
function pickChat(running, cwd) {
  if (cwd) {
    const hits = running
      .filter(/** @returns {r is { chatId: string, cwd: string }} */ (r) => !!r.cwd && within(cwd, r.cwd))
      .sort((a, b) => b.cwd.length - a.cwd.length);
    if (hits.length && (hits.length === 1 || hits[0].cwd.length > hits[1].cwd.length)) return hits[0].chatId;
  }
  return running.length === 1 ? running[0].chatId : null;
}

class BrowserShim {
  /**
   * @param {{ dir: string, open: (chatId: string, url: string) => Promise<boolean>,
   *           running?: () => { chatId: string, cwd: string | null }[] | Promise<{ chatId: string, cwd: string | null }[]>,
   *           platform?: string, tmpdir?: () => string, fallback?: () => string | null }} o
   *   dir: where the scripts go; open: true when the URL opened in the chat's pane;
   *   running: chats with a running turn and their project folders; fallback: the user's own BROWSER
   */
  constructor(o) {
    this.o = o;
    this.platform = o.platform ?? process.platform;
    this.running = o.running ?? (() => []);
    this.listener = new PrivateSocketListener({
      prefix: 'mpbr-',
      tmpdir: o.tmpdir,
      createServer: () => {
        const server = http.createServer((req, res) => void this.#handle(req, res));
        // never what keeps a process alive
        server.unref();
        return server;
      },
    });
    this.script = null;
    this.shared = crypto.randomBytes(16).toString('hex');
    /** token -> chat id */
    this.tokens = new Map();
    /** chat id -> token */
    this.byChat = new Map();
  }

  get supported() {
    return this.platform !== 'win32';
  }

  /** Writes the scripts and starts listening (once); resolves the socket path, or null where unsupported. */
  listen() {
    if (!this.supported) return Promise.resolve(null);
    if (this.listener.listening) return this.listener.listening;
    try {
      this.script = writeShim(this.o.dir);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.listener.listen();
  }

  get server() {
    return this.listener.server;
  }
  get sockDir() {
    return this.listener.dir;
  }
  get sock() {
    return this.listener.path;
  }
  get listening() {
    return this.listener.listening;
  }

  /** Stops listening now: a request still waiting (on a site card) is dropped, so quitting never waits on it. */
  close() {
    this.listener.close();
  }

  /** The chat's own token (made on first use). */
  tokenFor(chatId) {
    let t = this.byChat.get(chatId);
    if (!t) {
      t = crypto.randomBytes(16).toString('hex');
      this.byChat.set(chatId, t);
      this.tokens.set(t, chatId);
    }
    return t;
  }

  /** The chat is over: its token stops working. */
  forget(chatId) {
    const t = this.byChat.get(chatId);
    if (t) this.tokens.delete(t);
    this.byChat.delete(chatId);
  }

  /**
   * Env for a child process: BROWSER and how the script reaches main. `chatId` gives the chat's own
   * token; without one, the shared token. Empty until listening (or where unsupported). `base`: the
   * env it goes on top of, whose own BROWSER (the user's) stays the fallback.
   */
  env(/** @type {string | null} */ chatId = null, /** @type {Record<string, string>} */ base = {}) {
    if (!this.sock || !this.script) return {};
    const out = {
      BROWSER: this.script,
      MOPILOT_BROWSER_SOCK: this.sock,
      MOPILOT_BROWSER_TOKEN: chatId ? this.tokenFor(chatId) : this.shared,
    };
    // an env that already has the shim (MoPilot started from one of its own terminals) keeps its fallback
    const own = base.BROWSER && base.BROWSER !== this.script ? base.BROWSER : base.MOPILOT_BROWSER_FALLBACK || this.o.fallback?.() || null;
    if (own) out.MOPILOT_BROWSER_FALLBACK = own;
    return out;
  }

  /** The chat a request's token and folder name, or null. */
  async route(token, cwd) {
    if (typeof token !== 'string' || !token) return null;
    if (this.tokens.has(token)) return this.tokens.get(token);
    if (token !== this.shared) return null;
    let running = [];
    try {
      running = (await this.running()) || [];
    } catch (error) {
      // no running-chat list: pick from none
      noteIgnored('list the running chats for a $BROWSER request', error);
    }
    return pickChat(running, cwd || null);
  }

  async #handle(req, res) {
    const reply = (code, text) => {
      res.writeHead(code, { 'content-type': 'text/plain' });
      res.end(text);
    };
    if (req.method !== 'POST' || req.url !== '/open') return reply(404, 'not found');
    let body = '';
    let tooBig = false;
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) {
        tooBig = true;
        break;
      }
    }
    if (tooBig) return reply(413, 'too large');
    const form = new URLSearchParams(body);
    const url = form.get('url') || '';
    const chatId = await this.route(req.headers['x-mopilot-token'], form.get('cwd'));
    if (!chatId) return reply(409, 'no chat');
    if (!originOf(url)) return reply(409, 'not a web page');
    let ok = false;
    try {
      ok = await this.o.open(chatId, url);
    } catch (error) {
      // a 409 sends the shim on to the user's own browser, which still opens the URL
      noteIgnored('open a $BROWSER URL in the chat pane', error);
    }
    return ok ? reply(200, 'opened') : reply(409, 'not opened');
  }
}

module.exports = { BrowserShim, writeShim, pickChat, SH_SOURCE, JS_SOURCE, SCRIPT_NAME, SH_NAME };
