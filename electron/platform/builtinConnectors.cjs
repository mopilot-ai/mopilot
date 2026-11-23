// MoPilot's optional built-in connectors, delivered to every harness through the plugin store (electron/plugins/store.cjs): turning one on writes a small plugin that runs the connector's MCP server, so Claude Code, Codex and the basic-tier (ACP) harnesses all get it as any installed plugin.
//
// GitHub: GitHub's own github-mcp-server (MIT, https://github.com/github/github-mcp-server), a pinned release downloaded
// on first enable and checked against the SHA-256 pinned below. It signs in with the user's `gh` login, read when the
// server starts by a wrapper script (so no token is stored in any plugin file); turning the connector on is the consent.
// Nothing here is bundled with the app or downloaded before the user turns the connector on.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const childProcess = require('node:child_process');
const { pluginId } = require('../../shared/plugins/manifest.mjs');

const MARKETPLACE = 'mopilot-builtin';
const VERSION = '2.0.3';
const BASE_URL = `https://github.com/github/github-mcp-server/releases/download/v${VERSION}`;
/** The release's archives for the platforms it covers (Windows has none here: its connector stays unavailable). */
const GITHUB_ASSETS = {
  'darwin-arm64': {
    file: 'github-mcp-server_Darwin_arm64.tar.gz',
    sha256: '5c95c01f75a7ec2370607e989b2968d314b02a54d78af8a9fdf38f3dfe6135f4',
  },
  'darwin-x64': {
    file: 'github-mcp-server_Darwin_x86_64.tar.gz',
    sha256: '115350858c3287843274efbf45e821d98f15d3304cb2c074740461ed32b45598',
  },
  'linux-arm64': {
    file: 'github-mcp-server_Linux_arm64.tar.gz',
    sha256: '5d2ddc71273fec8917e8f42cf19f26a6bd7acbb679b3a57de2917018b2eadf82',
  },
  'linux-x64': {
    file: 'github-mcp-server_Linux_x86_64.tar.gz',
    sha256: 'f797c20fe02a755865d0e2d46184ab47e31bf1619b0855b8d89c531e45a651c2',
  },
};
/** The most an archive may be: the release's are about 9 MB. */
const MAX_ARCHIVE = 64 * 1024 * 1024;

/** The connectors, by id. */
const CONNECTORS = {
  github: {
    id: 'github',
    title: 'GitHub',
    description: 'GitHub’s official MCP server, signed in with your gh login.',
    version: VERSION,
    plugin: pluginId('github', MARKETPLACE),
  },
};

/** A shell word for `s`: single-quoted. */
const shellWord = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The wrapper the harnesses run: reads the token from the environment or `gh` at start, never from a file. */
function wrapperScript(binary, gh) {
  return `#!/bin/sh
# MoPilot built-in GitHub connector: github-mcp-server, signed in with the gh login (nothing is stored here).
if [ -z "$GITHUB_PERSONAL_ACCESS_TOKEN" ]; then
  GH=${shellWord(gh)}
  [ -x "$GH" ] || GH=gh
  GITHUB_PERSONAL_ACCESS_TOKEN="$("$GH" auth token 2>/dev/null)"
  export GITHUB_PERSONAL_ACCESS_TOKEN
fi
if [ -z "$GITHUB_PERSONAL_ACCESS_TOKEN" ]; then
  echo "GitHub connector: no GitHub login found. Run 'gh auth login'." >&2
  exit 1
fi
exec ${shellWord(binary)} stdio
`;
}

/** The plugin folder's files for a binary and a gh path. */
function pluginFiles(binary, gh) {
  return {
    '.claude-plugin/plugin.json': JSON.stringify(
      {
        name: 'github',
        version: VERSION,
        description: 'GitHub MCP server (github/github-mcp-server, MIT), a MoPilot built-in connector.',
      },
      null,
      2,
    ),
    '.mcp.json': JSON.stringify({ mcpServers: { github: { command: '${CLAUDE_PLUGIN_ROOT}/run.sh', args: [] } } }, null, 2),
    'run.sh': wrapperScript(binary, gh),
  };
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Runs a file and resolves {ok, stdout}. */
const exec = (file, args, opts = {}) =>
  new Promise((resolve) =>
    childProcess.execFile(file, args, { timeout: 60_000, ...opts }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout || '') })),
  );

/**
 * @param {object} o
 * @param {{ list(): Promise<{plugins: {id: string, enabled: boolean}[]}>, preview(dir: string): Promise<any>, install(dir: string, o: object): Promise<any>, uninstall(id: string): Promise<boolean> }} o.store the plugin store
 * @param {() => string} [o.dir] where connector files live (~/.mopilot/connectors)
 * @param {NodeJS.Platform} [o.platform]
 * @param {string} [o.arch]
 * @param {(url: string) => Promise<Buffer>} [o.download]
 * @param {(archive: string, into: string) => Promise<boolean>} [o.extract] unpacks github-mcp-server from the archive
 * @param {() => Promise<{ gh: string, signedIn: boolean }>} [o.login] the gh executable and whether a token is available
 */
function createBuiltinConnectors(o) {
  const { store } = o;
  const dir = o.dir ?? (() => path.join(os.homedir(), '.mopilot', 'connectors'));
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const asset = GITHUB_ASSETS[`${platform}-${arch}`];
  const download =
    o.download ??
    (async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Couldn’t download the GitHub connector (${res.status})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_ARCHIVE) throw new Error('The GitHub connector download is larger than expected');
      return buf;
    });
  const extract =
    o.extract ?? (async (archive, into) => (await exec('/usr/bin/tar', ['-xzf', archive, '-C', into, 'github-mcp-server'])).ok);
  const login =
    o.login ??
    (async () => {
      const env = require('./env.cjs').gitEnv();
      const found = await exec('/usr/bin/which', ['gh'], { env });
      const gh = found.stdout.trim() || 'gh';
      const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || (await exec(gh, ['auth', 'token'], { env })).stdout.trim();
      return { gh, signedIn: !!token };
    });
  const root = () => path.join(dir(), 'github');
  const binaryPath = () => path.join(root(), VERSION, 'github-mcp-server');
  /** One chain for enable and disable: they rewrite the same files and the same store record. */
  let chain = Promise.resolve();
  const enqueue = (run) => {
    const next = chain.then(run, run);
    // a failed step is its caller's to report; the next one runs regardless (chain.then(run, run))
    chain = next;
    return next;
  };

  /** Whether the binary on disk is the one unpacked from the checked archive (a sidecar holds its hash): a truncated or replaced file is fetched again. */
  const unchanged = (bin) => {
    try {
      return fs.readFileSync(`${bin}.sha256`, 'utf8').trim() === sha256(fs.readFileSync(bin));
    } catch {
      return false;
    }
  };

  /** The pinned binary on disk, downloaded and checked first when it isn't there (or isn't what was unpacked). */
  async function ensureBinary() {
    const bin = binaryPath();
    if (unchanged(bin)) return bin;
    const buf = await download(`${BASE_URL}/${asset.file}`);
    if (sha256(buf) !== asset.sha256) throw new Error('The GitHub connector download didn’t match its checksum, so it wasn’t installed');
    const tmp = fs.mkdtempSync(path.join(dir(), '.download-'));
    try {
      const archive = path.join(tmp, asset.file);
      fs.writeFileSync(archive, buf, { mode: 0o600 });
      if (!(await extract(archive, tmp)) || !fs.existsSync(path.join(tmp, 'github-mcp-server')))
        throw new Error('Couldn’t unpack the GitHub connector');
      fs.chmodSync(path.join(tmp, 'github-mcp-server'), 0o755);
      fs.mkdirSync(path.dirname(bin), { recursive: true, mode: 0o700 });
      fs.writeFileSync(`${bin}.sha256`, sha256(fs.readFileSync(path.join(tmp, 'github-mcp-server'))), { mode: 0o600 });
      fs.renameSync(path.join(tmp, 'github-mcp-server'), bin);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return bin;
  }

  async function enableGithub() {
    if (!asset) throw new Error('The GitHub connector isn’t available on this computer yet');
    const { gh, signedIn } = await login();
    if (!signedIn) throw new Error('Sign in to GitHub first: run “gh auth login”, then turn this on');
    fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
    const bin = await ensureBinary();
    const src = path.join(root(), 'plugin');
    fs.rmSync(src, { recursive: true, force: true });
    for (const [name, text] of Object.entries(pluginFiles(bin, gh))) {
      const file = path.join(src, name);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, text, { mode: name === 'run.sh' ? 0o755 : 0o644 });
    }
    const preview = await store.preview(src);
    if (!preview.ok) throw new Error(preview.error);
    const installed = await store.install(src, { marketplace: MARKETPLACE, trust: preview.trust, origin: 'builtin' });
    return installed.id;
  }

  return {
    CONNECTORS,
    /** Each connector with its state: `on`, `off`, or `unavailable` (with why). */
    async list() {
      const { plugins } = await store.list();
      return Object.values(CONNECTORS).map((c) => {
        const have = plugins.find((p) => p.id === c.plugin);
        const base = { id: c.id, title: c.title, description: c.description, version: c.version };
        if (!asset) return { ...base, state: 'unavailable', why: 'Not available on this computer yet' };
        return { ...base, state: have?.enabled ? 'on' : 'off' };
      });
    },
    /** Turns a connector on (downloading and checking it first time) or off. Resolves the new list. */
    set(id, on) {
      if (!CONNECTORS[id]) return Promise.reject(new Error(`No built-in connector named “${id}”`));
      return enqueue(async () => {
        if (on === true) await enableGithub();
        else await store.uninstall(CONNECTORS[id].plugin);
        return this.list();
      });
    },
  };
}

module.exports = { createBuiltinConnectors, wrapperScript, pluginFiles, GITHUB_ASSETS, CONNECTORS, MARKETPLACE, VERSION, BASE_URL };
