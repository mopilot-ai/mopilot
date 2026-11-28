// Downloads SquillaRouter's pinned OpenSquilla weights into a folder, verifying each file's size and SHA-256.
//   node scripts/fetch-auto-route-assets.mjs [--out <dir>] [--from <dir of already-downloaded files>]
// --out defaults to build/vendor/auto-route/squilla, where a checkout and scripts/package.mjs look for them.
// --from copies files found there by name (flat or in the same layout) instead of downloading; they are verified the same way.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const UPSTREAM = JSON.parse(readFileSync(path.join(root, 'electron/autoRoute/squilla/upstream.json'), 'utf8'));
export const DEFAULT_OUT = path.join(root, 'build/vendor/auto-route/squilla');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The download URL of one pinned file: Git LFS objects come from media.githubusercontent.com. */
export function fileUrl(file, upstream = UPSTREAM) {
  const host = file.lfs ? 'https://media.githubusercontent.com/media' : 'https://raw.githubusercontent.com';
  return `${host}/${upstream.repository}/${upstream.commit}/${file.path}`;
}

/** Throws unless the bytes are the pinned file (and, for the gzipped tier model, its pinned contents). */
export function verify(file, bytes) {
  if (bytes.length !== file.size) throw new Error(`${file.name}: ${bytes.length} bytes, expected ${file.size}`);
  if (sha256(bytes) !== file.sha256) throw new Error(`${file.name}: SHA-256 does not match the pinned file`);
  if (file.gunzippedSha256) {
    const text = gunzipSync(bytes);
    if (text.length !== file.gunzippedSize || sha256(text) !== file.gunzippedSha256)
      throw new Error(`${file.name}: gunzipped contents do not match the pinned file`);
  }
}

/** Whether `file` is already in `out`, verified. */
function present(out, file) {
  const p = path.join(out, file.name);
  if (!existsSync(p)) return false;
  try {
    verify(file, readFileSync(p));
    return true;
  } catch {
    return false;
  }
}

/** Whether a folder already holds every pinned file, verified. */
export const complete = (out, upstream = UPSTREAM) => upstream.files.every((f) => present(out, f));

/**
 * @param {{ out?: string, from?: string, fetchImpl?: (url: string) => Promise<{ ok: boolean, status: number, arrayBuffer: () => Promise<ArrayBuffer | Uint8Array> }>, log?: (s: string) => void, upstream?: typeof UPSTREAM }} [o]
 */
export async function fetchAssets({ out = DEFAULT_OUT, from, fetchImpl = fetch, log = console.log, upstream = UPSTREAM } = {}) {
  for (const file of upstream.files) {
    if (present(out, file)) continue;
    const target = path.join(out, file.name);
    let bytes;
    if (from) {
      const local = [path.join(from, file.name), path.join(from, path.basename(file.name))].find((p) => existsSync(p));
      if (!local) throw new Error(`${file.name} is not in ${from}`);
      bytes = readFileSync(local);
    } else {
      const url = fileUrl(file, upstream);
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`${file.name}: HTTP ${res.status} from ${url}`);
      bytes = Buffer.from(new Uint8Array(await res.arrayBuffer()));
    }
    verify(file, bytes);
    rmSync(target, { force: true });
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(`${target}.partial`, bytes);
    renameSync(`${target}.partial`, target);
    log(`auto-route asset ${file.name} (${bytes.length} bytes) verified`);
  }
  return out;
}

const flag = (argv, name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

/**
 * The command line; returns the exit code.
 * @param {string[]} argv
 * @param {{ fetch?: (o: { out: string, from?: string, log: (s: string) => void }) => Promise<string>, log?: (s: string) => void, error?: (s: string) => void }} [deps]
 */
export async function main(argv, { fetch: run = fetchAssets, log = console.log, error = console.error } = {}) {
  try {
    const out = flag(argv, 'out');
    const ready = await run({ out: out ? path.resolve(out) : DEFAULT_OUT, from: flag(argv, 'from'), log });
    log(`auto-route assets ready in ${ready}`);
    return 0;
  } catch (e) {
    error(e.message);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
