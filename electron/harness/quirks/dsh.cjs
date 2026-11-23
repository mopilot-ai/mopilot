// dsh (DeepSeek Harness) over ACP: `dsh --profile acp --patch <sage.patch.yml>`.
// By default dsh attaches up to 8 MiB of the session log to every request to the official DeepSeek
// API (the session-log-deepseek row), and its OTel session telemetry carries an anonymous id. The
// patch turns the session log off and sets the telemetry row's mode to DISABLED; DSH_TELEMETRY_DISABLED=1
// is set as well, but --dump-config doesn't show that switch (the launcher applies it after the dump).
// dsh changes every few days, and a patch whose row id no longer matches would silently do nothing,
// so before every start `--dump-config` with the same arguments must show both off; otherwise it
// doesn't start.
// One process (workspace-write with ask, dsh's default); DSH_HOME is the user's own.
// It lists no auth methods, and with no DeepSeek key its sessions still open (on its default model); every turn then
// fails with "no API key for provider route". `setup` reads it as needing a key instead of Ready: admission looks for
// the key where dsh does (hasKey: the environment, then $DSH_HOME/.credentials.yaml, which its Models page writes, then
// $DSH_HOME/.env), and a turn failing for a missing or rejected key (or a session left with no model) flips it.
const { proc: childProcess } = require('../../platform/ports/proc.cjs');
const { fs } = require('../../platform/ports/fs.cjs');
const os = require('node:os');
const path = require('node:path');

const { noteIgnored } = require('../../ignored.cjs');
const { spawnArgs } = require('../../platform/winbin.cjs');

const PATCH = fs.readFileSync(path.join(__dirname, 'dsh.patch.yml'), 'utf8');

const SESSION_LOG = 'session-log-deepseek';
const TELEMETRY = 'session-telemetry-otel';
const GATE_TIMEOUT_MS = 20_000;
const NO_SESSION_LOG_OFF = "This dsh version can't turn off session log upload";
const KEY = 'DEEPSEEK_API_KEY';

/**
 * Whether dsh has a DeepSeek key to run on, looked for where dsh looks (dsh-credentials-local): the environment it
 * starts with, its credentials document ($DSH_HOME/.credentials.yaml: a `refs` entry, or an api-key record under a
 * deepseek scope), the .env of the folder it starts in (MoPilot starts it in the home folder, AcpHost's cwd), then
 * $DSH_HOME/.env. $DSH_HOME defaults to ~/.dsh. Only names are looked for; a value is never read out.
 */
function hasKey({ env = process.env, home = os.homedir() } = {}) {
  if (env[KEY]) return true;
  const dir = env.DSH_HOME || path.join(home, '.dsh');
  const has = (file, re) => {
    try {
      return re.test(fs.readFileSync(path.resolve(dir, file), 'utf8'));
    } catch (error) {
      // no such file is no key there; anything else is no key MoPilot can see, and dsh says so at the first turn
      if (error?.code !== 'ENOENT') noteIgnored(`read dsh's ${file}`, error);
      return false;
    }
  };
  // a .env line: `[export ]DEEPSEEK_API_KEY=…`
  const dotenv = /^\s*(export\s+)?DEEPSEEK_API_KEY\s*=\s*\S/m;
  return (
    // under `refs:`, `DEEPSEEK_API_KEY: …`; under `records:`, `<scope>/<id>:` with a deepseek scope
    has('.credentials.yaml', /^\s*['"]?(DEEPSEEK_API_KEY|[^\s'":/]*deepseek[^\s'":/]*\/[^\s'":]+)['"]?\s*:/im) ||
    has(path.join(home, '.env'), dotenv) ||
    has('.env', dotenv)
  );
}

/** Writes the patch where MoPilot keeps harness files; returns its path. */
function writePatch(dataDir) {
  const dir = path.join(dataDir, 'dsh');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sage.patch.yml');
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== PATCH) fs.writeFileSync(file, PATCH);
  return file;
}

/** Every entry with this id in a composed config tree printed as JSON. */
function jsonEntries(node, id, out = []) {
  if (Array.isArray(node)) for (const x of node) jsonEntries(x, id, out);
  else if (node && typeof node === 'object') {
    if (node.id === id) out.push(node);
    for (const v of Object.values(node)) if (v && typeof v === 'object') jsonEntries(v, id, out);
  }
  return out;
}

/**
 * Every `- id: <id>` block in a tree printed as YAML: the lines under it, up to the next entry at
 * the same or a lower indent.
 */
function yamlEntries(text, id) {
  const lines = String(text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)-\s+id:\s*['"]?([^'"\s#]+)['"]?\s*(#.*)?$/.exec(lines[i]);
    if (!m || m[2] !== id) continue;
    const indent = m[1].length;
    const block = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) continue;
      const ind = l.length - l.trimStart().length;
      if (ind <= indent) break;
      block.push(l.trim());
    }
    out.push({
      disabled: block.some((l) => /^disabled:\s*true\b/.test(l)),
      enabled: block.find((l) => /^enabled:\s*(true|false)\b/.test(l))?.match(/(true|false)/)?.[1] ?? null,
      mode:
        block
          .find((l) => /^mode:/.test(l))
          ?.replace(/^mode:\s*/, '')
          .replace(/['"]/g, '') ?? null,
    });
  }
  return out;
}

/** What --dump-config says about the two rows: {sessionLog: 'off'|'on'|'unknown', telemetry: 'off'|'on'|'absent'}. */
function readDump(text) {
  let entries;
  try {
    const tree = JSON.parse(text);
    entries = (id) =>
      jsonEntries(tree, id).map((e) => ({
        disabled: e.disabled === true,
        enabled: e.config && 'enabled' in e.config ? String(e.config.enabled) : null,
        mode: e.config?.mode ?? null,
      }));
  } catch {
    entries = (id) => yamlEntries(text, id);
  }
  const log = entries(SESSION_LOG);
  const tel = entries(TELEMETRY);
  const off = (e) => e.disabled || e.enabled === 'false';
  return {
    sessionLog: !log.length ? 'unknown' : log.every(off) ? 'off' : 'on',
    telemetry: !tel.length ? 'absent' : tel.every((e) => e.disabled || /^DISABLED$/i.test(e.mode ?? '')) ? 'off' : 'on',
  };
}

/** The privacy gate: fail closed unless the composed config shows both off. */
function privacyGate({ bin, args, env }) {
  return new Promise((resolve) => {
    // through its real program: npm's dsh.cmd can't be started directly on Windows (EINVAL)
    childProcess.execFile(
      ...spawnArgs(bin, [...args, '--dump-config'], { env, timeout: GATE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }),
      (err, stdout) => {
        if (err && !stdout)
          return resolve({
            ok: false,
            reason: `${NO_SESSION_LOG_OFF} (--dump-config failed: ${String(err.message ?? err).split('\n')[0]})`,
          });
        const r = readDump(String(stdout ?? ''));
        if (r.sessionLog !== 'off') return resolve({ ok: false, reason: NO_SESSION_LOG_OFF });
        if (r.telemetry === 'on') return resolve({ ok: false, reason: "This dsh version can't turn off its telemetry" });
        resolve({ ok: true, reason: null });
      },
    );
  });
}

module.exports = {
  label: 'dsh',
  bins: ['dsh'],
  launch: ({ dataDir }) => {
    if (!dataDir) throw new Error('No folder for the dsh patch');
    return { args: ['--profile', 'acp', '--patch', writePatch(dataDir)], env: { DSH_TELEMETRY_DISABLED: '1' } };
  },
  privacyDefaults: ['session-log-deepseek (session log upload with each request)', 'OTel session telemetry (DSH_TELEMETRY_DISABLED=1)'],
  admission: { handshakeTimeoutMs: 10_000, privacyGate },
  setup: {
    model: true,
    ready: ({ env }) => hasKey({ env }),
    // no key, a key the API rejects, or a session with no model to run on
    error: /no API key for provider route|Authentication Fails|has no provider\/model/,
    // ~/.dsh/.env is read at each start; the login shell's env only when MoPilot starts (platform/env.cjs)
    reason:
      'Needs a valid DeepSeek API key: add DEEPSEEK_API_KEY=<your key> to ~/.dsh/.env and Re-check (or export it in your shell profile and restart MoPilot)',
  },
  // dsh's DeepSeek models by id (its ACP session declares no image input, so images are never sent)
  modalities: { 'deepseek-flash': ['text', 'image'], 'deepseek-v4-pro': ['text'] },
  instructionsFiles: ['AGENTS.md', 'CLAUDE.md'],
  // helpers for tests
  _test: { PATCH, readDump, writePatch, hasKey },
};
