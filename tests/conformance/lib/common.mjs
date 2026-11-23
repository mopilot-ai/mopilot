// Shared plumbing for the real-CLI conformance probes: args, temp dirs, JSONL recording,
// timeouts, cleanup, verdicts, results files and the config-file safety check.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scrub, scrubDeep } = require('../../../shared/scrub.cjs');

export const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DEFAULTS = {
  claude: { model: 'haiku', effort: 'low' },
  codex: { model: 'gpt-6-luna', effort: 'low' },
};

export function parseArgs(argv) {
  /** @type {{ harness: string | null, only: string[] | null, model: string | null, effort: string | null, bin: string | null, out: string, keep: boolean, recordProtected: boolean }} */
  const o = {
    harness: null,
    only: null,
    model: null,
    effort: null,
    bin: null,
    out: path.join(REPO, 'conformance/results'),
    keep: false,
    recordProtected: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--harness') o.harness = next();
    else if (a === '--only')
      o.only = next()
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    else if (a === '--model') o.model = next();
    else if (a === '--effort') o.effort = next();
    else if (a === '--bin') o.bin = next();
    else if (a === '--out') o.out = path.resolve(next());
    else if (a === '--keep') o.keep = true;
    // inside the VM only (run.mjs checks): a write to a protected file fails that check and the run goes on
    else if (a === '--record-protected') o.recordProtected = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.harness !== 'claude' && o.harness !== 'codex') throw new Error('--harness must be claude or codex');
  o.model ??= DEFAULTS[o.harness].model;
  o.effort ??= DEFAULTS[o.harness].effort;
  return o;
}

/** Turns {label: boolean} into a verdict. Every label is a fact recorded in the baseline. */
export function judge(expect) {
  const mismatches = Object.entries(expect)
    .filter(([, ok]) => !ok)
    .map(([k]) => k);
  return { verdict: mismatches.length ? 'fail' : 'pass', mismatches };
}

const BLOB = /([A-Za-z0-9+/]{200,}={0,2})/g;
/** Scrubs secrets, emails and home paths, and drops base64 blobs from a log line. */
export function redact(line) {
  return scrub(String(line).replace(BLOB, '<base64>'), { home: os.homedir() });
}

/** Appends one JSON object per line. */
export class Recorder {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  }
  write(obj) {
    let s;
    try {
      s = JSON.stringify({ t: Date.now(), ...obj });
    } catch {
      s = JSON.stringify({ t: Date.now(), unserializable: String(obj) });
    }
    if (s.length > 50000) s = JSON.stringify({ t: Date.now(), truncated: s.slice(0, 50000) });
    fs.appendFileSync(this.file, redact(s) + '\n');
  }
}

/** Files Sage must never write. Only stat()ed, never read. */
export function protectedFiles() {
  const h = os.homedir();
  return [
    path.join(process.env.CODEX_HOME || path.join(h, '.codex'), 'config.toml'),
    path.join(h, '.claude/settings.json'),
    path.join(h, '.claude/settings.local.json'),
  ];
}
export function snapshotProtected() {
  return Object.fromEntries(
    protectedFiles().map((f) => {
      try {
        const s = fs.statSync(f);
        return [f, `${s.size}:${s.mtimeMs}`];
      } catch {
        return [f, null];
      }
    }),
  );
}
/**
 * A check during which a protected file changed, as a failed check: the CLI wrote the user's config, which MoPilot
 * promises never happens. Used by --record-protected in the VM, where the files are the VM's.
 * @param {{ verdict: string, observed?: { mismatches?: string[] } }} r @param {string[]} changed
 */
export function protectedFailure(r, changed) {
  const home = os.homedir();
  const wrote = changed.map((f) => `wrote ${f.startsWith(home) ? `~${f.slice(home.length)}` : f}`);
  return { ...r, verdict: 'fail', observed: { ...r.observed, mismatches: [...(r.observed?.mismatches ?? []), ...wrote] } };
}
export function changedProtected(before) {
  const now = snapshotProtected();
  return Object.keys(before).filter((f) => before[f] !== now[f]);
}

/** Per-probe context: temp cwds, recorders, cleanup stack. */
export function makeCtx({ kind, mod, opts, logDir }) {
  const evidence = [];
  const cleanups = [];
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sage-conf-${mod.id}-`)));
  let n = 0;
  const ctx = {
    kind,
    id: mod.id,
    title: mod.title,
    model: opts.model,
    effort: opts.effort,
    cliVersion: opts.cliVersion,
    bin: opts.binPath,
    tmpRoot,
    /** A fresh, empty, realpath'd directory under this probe's temp root. */
    cwd(name = 'cwd') {
      const d = path.join(tmpRoot, `${name}-${++n}`);
      fs.mkdirSync(d, { recursive: true });
      return d;
    },
    recorder(name = '') {
      const file = path.join(logDir, `${mod.id}${name ? '-' + name : ''}.jsonl`);
      evidence.push(path.relative(REPO, file));
      return new Recorder(file);
    },
    defer(fn) {
      cleanups.push(fn);
    },
    async cleanup() {
      while (cleanups.length) {
        const fn = cleanups.pop();
        try {
          await Promise.race([fn(), sleep(20000)]);
        } catch {
          /* one failed cleanup must not skip the rest */
        }
      }
      if (!opts.keep) fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
    /** Builds the probe's return value. */
    result(observed, expect = {}, extra = {}) {
      const { verdict, mismatches } = judge(expect);
      return {
        id: mod.id,
        title: mod.title,
        verdict: extra.verdict ?? verdict,
        observed: scrubDeep({ ...observed, ...(mismatches.length ? { mismatches } : {}) }, { home: os.homedir() }),
        evidence: [...evidence],
      };
    },
  };
  return ctx;
}

/** Runs one probe with a timeout; always cleans up. */
export async function runProbe(mod, ctx) {
  const t0 = Date.now();
  let timer;
  let res;
  try {
    res = await Promise.race([
      mod.default(ctx),
      new Promise(
        (_, rej) => (timer = setTimeout(() => rej(new Error(`probe timeout after ${mod.timeoutMs} ms`)), mod.timeoutMs ?? 300000)),
      ),
    ]);
  } catch (e) {
    ctx.recorder('error').write({ error: String(e?.stack || e) });
    res = ctx.result({ error: String(e?.message || e) }, {}, { verdict: 'error' });
  } finally {
    clearTimeout(timer);
    await ctx.cleanup();
  }
  return { ...res, seconds: Math.round((Date.now() - t0) / 1000), ranAt: new Date().toISOString(), model: ctx.model, effort: ctx.effort };
}

/** Merges checks into conformance/results/<kind>@<version>.json, keeping checks not run this time. */
export function writeResults(file, header, checks) {
  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* no previous results file: start fresh */
  }
  const byId = new Map((prev.checks ?? []).map((c) => [c.id, c]));
  for (const c of checks) byId.set(c.id, c);
  const order = (id) => [id[0], Number(id.slice(1))];
  const all = [...byId.values()].sort((a, b) => {
    const [pa, na] = order(a.id);
    const [pb, nb] = order(b.id);
    return pa === pb ? na - nb : pa < pb ? -1 : 1;
  });
  const out = { ...prev, ...header, updatedAt: new Date().toISOString(), checks: all };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
}

export function summaryTable(results) {
  const rows = results.map((r) => [
    r.id,
    r.verdict,
    `${r.seconds ?? '-'}s`,
    r.title,
    (r.observed?.mismatches ?? (r.observed?.error ? [r.observed.error] : [])).join('; '),
  ]);
  const head = ['id', 'verdict', 'time', 'title', 'mismatches'];
  const w = head.map((h, i) => Math.min(60, Math.max(h.length, ...rows.map((r) => String(r[i]).length))));
  const fmt = (r) => r.map((c, i) => String(c).slice(0, 60).padEnd(w[i])).join('  ');
  return [fmt(head), w.map((x) => '-'.repeat(x)).join('  '), ...rows.map(fmt)].join('\n');
}

/**
 * The binary the app would run among candidates (each {path, version}): the newest working release, a prerelease only
 * when no release is there (electron/harness/versions.cjs preferredInstalls, with `kind`'s versions policy), or null.
 */
export function newestInstall(found, kind) {
  return require('../../../electron/harness/versions.cjs').preferredInstalls(found, kind)[0] ?? null;
}
