// Reads the files a harness's route comes from (shared/harnessRoutes.mjs) into what shared/route.mjs classifies: each file parsed as TOML, JSON, YAML or dotenv, with its modification time.
const { fs: fsPort } = require('../platform/ports/fs.cjs');
const { parse: parseToml } = require('smol-toml');
const { expandPath } = require('../../shared/route.mjs');
const { messageOf } = require('../ignored.cjs');

/** KEY=value lines, as the dotenv files harnesses read (`export`, quotes and # comments allowed). */
function parseDotenv(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(v);
    v = quoted ? quoted[2] : v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

/** JSON, and the JSON-with-comments some harnesses accept in settings.json. */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    // drop // and /* */ comments outside strings, and trailing commas, then try once more
    const stripped = text
      .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (_, str) => str ?? ' ')
      .replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (_, str, close) => str ?? close);
    if (stripped === text) throw error;
    return JSON.parse(stripped);
  }
}

const PARSERS = {
  toml: (t) => parseToml(t),
  json: parseJson,
  // js-yaml loads with the first YAML route file, not with main's startup
  yaml: (t) => require('js-yaml').load(t) ?? {},
  dotenv: parseDotenv,
};

/** The files of a harness that apply on this platform, with their paths expanded. */
function filesFor(info, { env, home, platform }) {
  return info.files.filter((f) => !f.os || f.os.includes(platform)).map((f) => ({ ...f, path: expandPath(f.path, env, home) }));
}

/**
 * Every declared file of a harness, read now: its parsed contents, or no `doc` when it doesn't exist, or the
 * parse error; and the newest modification time among the files that exist (0 when none does).
 * @param {import('../../shared/harnessRoutes.mjs').HarnessRouteInfo} info
 * @param {{ env: Record<string, string | undefined>, home: string, platform: string, fs?: typeof fsPort.promises }} o
 * @returns {Promise<{ docs: import('../../shared/route.mjs').RouteDocs, mtimeMs: number, paths: string[] }>}
 */
async function readRouteDocs(info, { env, home, platform, fs = fsPort.promises }) {
  const files = filesFor(info, { env, home, platform });
  /** @type {import('../../shared/route.mjs').RouteDocs['files']} */
  const out = {};
  let mtimeMs = 0;
  await Promise.all(
    files.map(async (f) => {
      let text;
      try {
        const st = await fs.stat(f.path);
        mtimeMs = Math.max(mtimeMs, st.mtimeMs);
        text = await fs.readFile(f.path, 'utf8');
      } catch (error) {
        // a file that isn't there sets nothing; one that can't be read says why
        out[f.id] = error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? { path: f.path } : { path: f.path, error: messageOf(error) };
        return;
      }
      try {
        out[f.id] = { path: f.path, doc: PARSERS[f.format](text), error: null };
      } catch {
        // Parser messages can quote config values, including credentials: publish only the format and source.
        out[f.id] = { path: f.path, error: `Couldn't read ${f.path}: Invalid ${f.format.toUpperCase()} configuration` };
      }
    }),
  );
  return { docs: { env, files: out }, mtimeMs, paths: files.map((f) => f.path) };
}

module.exports = { readRouteDocs, filesFor, parseDotenv, parseJson };
