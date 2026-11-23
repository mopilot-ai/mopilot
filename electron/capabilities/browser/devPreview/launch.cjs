// Preview launch-file parsing, local URL normalization and TCP readiness probes.
const { fs } = require('../../../platform/ports/fs.cjs');
const net = require('node:net');
const path = require('node:path');
const { oneLine } = require('../host.cjs');
const { originOf } = require('../origins.cjs');
const { stripAnsi } = require('../../../../shared/ansiText.mjs');

const LAUNCH_FILES = ['.mopilot/launch.json', '.claude/launch.json'];
const CONNECT_MS = 1_000;
const READY_MS = 45_000;
const LOCAL_URL = /\b(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(:\d{2,5})?(\/[^\s'"<>)]*)?/i;

/** The first local URL a server printed (0.0.0.0 and [::] read as localhost), or null. */
function findLocalUrl(text) {
  const m = LOCAL_URL.exec(stripAnsi(text));
  if (!m) return null;
  const [, scheme, name, port, rest] = m;
  const host = /^(0\.0\.0\.0|\[::\])$/.test(name) ? 'localhost' : name;
  return `${scheme.toLowerCase()}://${host}${port || ''}${rest || '/'}`;
}

/** The port a URL names (its default when it names none), or null. */
function portOf(url) {
  try {
    const u = new URL(url);
    return Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  } catch {
    return null;
  }
}

const isStringList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * The project's launch configurations. Each file is read once; a configuration needs a name and a
 * runtimeExecutable. `${workspaceFolder}` in its strings is the project folder.
 * @returns {{ configs: { name: string, runtimeExecutable: string, runtimeArgs: string[], port: number | null, url: string | null, cwd: string, env: Record<string, string>, source: string }[], errors: string[] }}
 */
function readLaunchConfigs(projectDir, { readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const configs = [];
  const errors = [];
  if (!projectDir) return { configs, errors };
  const sub = (s) => String(s).split('${workspaceFolder}').join(projectDir);
  for (const rel of LAUNCH_FILES) {
    let data;
    try {
      data = JSON.parse(readFile(path.join(projectDir, rel)));
    } catch (e) {
      if (e?.code !== 'ENOENT') errors.push(`${rel}: ${oneLine(e?.message || e, 200)}`);
      continue;
    }
    const list = Array.isArray(data?.configurations) ? data.configurations : [];
    for (const c of list) {
      if (!c || typeof c.name !== 'string' || !c.name || typeof c.runtimeExecutable !== 'string' || !c.runtimeExecutable) {
        errors.push(`${rel}: a configuration needs a name and a runtimeExecutable`);
        continue;
      }
      if (configs.some((x) => x.name === c.name)) continue;
      const port = Number.isInteger(c.port) && c.port > 0 && c.port < 65536 ? c.port : null;
      const env = {};
      if (c.env && typeof c.env === 'object') for (const [k, v] of Object.entries(c.env)) if (v != null) env[k] = sub(v);
      configs.push({
        name: c.name,
        runtimeExecutable: sub(c.runtimeExecutable),
        runtimeArgs: isStringList(c.runtimeArgs) ? c.runtimeArgs.map(sub) : [],
        port,
        url: typeof c.url === 'string' && originOf(sub(c.url)) ? sub(c.url) : null,
        cwd: typeof c.cwd === 'string' && c.cwd ? path.resolve(projectDir, sub(c.cwd)) : projectDir,
        env,
        source: rel,
      });
    }
  }
  return { configs, errors };
}

/** Whether something accepts TCP connections on host:port. */
function probePort(port, { host = 'localhost', connect = net.connect, timeoutMs = CONNECT_MS } = {}) {
  return new Promise((resolve) => {
    let s;
    const done = (ok) => {
      s?.destroy();
      resolve(ok);
    };
    try {
      s = connect({ host, port });
    } catch {
      return resolve(false);
    }
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(timeoutMs, () => done(false));
  });
}

module.exports = { LAUNCH_FILES, READY_MS, stripAnsi, findLocalUrl, portOf, readLaunchConfigs, probePort };
