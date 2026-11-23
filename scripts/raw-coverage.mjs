// Raw V8 coverage carried between CI jobs: a test shard packs only the repository's own scripts, without their source text and under a placeholder root, and the job that writes the report unpacks them under its own checkout.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// the runners check out the repository at different paths (/home/runner/… on Linux, /Users/runner/… on macOS)
const URL_ROOT = '@REPO_URL@';
const PATH_ROOT = '@REPO_PATH@';

/** The checkout's root as a file URL and as a path, both without a trailing separator. */
function roots(repoRoot) {
  const dir = path.resolve(repoRoot);
  return { href: pathToFileURL(dir).href, dir };
}

/**
 * Keep a raw coverage file's scripts from the repository itself (c8 reports nothing else) and their source maps
 * without `sourcesContent` or `names`: the release repository's artifacts are public, and the report reads the
 * sources from its own checkout instead.
 * @param {{ result: { url: string }[], 'source-map-cache'?: Record<string, { data?: Record<string, unknown> | null }> }} data
 */
export function ownScripts(data, repoRoot) {
  const prefix = `${roots(repoRoot).href}/`;
  const own = (url) => url.startsWith(prefix) && !url.includes('/node_modules/');
  const result = data.result.filter((script) => own(script.url));
  const maps = data['source-map-cache'];
  if (!maps) return { ...data, result };
  const kept = new Set(result.map((script) => script.url));
  const cache = Object.fromEntries(
    Object.entries(maps)
      .filter(([url]) => kept.has(url))
      .map(([url, entry]) => {
        if (!entry.data) return [url, entry];
        const { sourcesContent, names, ...map } = entry.data;
        return [url, { ...entry, data: map }];
      }),
  );
  return { ...data, result, 'source-map-cache': cache };
}

/** Copy every raw coverage file in `from` into `to`, trimmed by ownScripts, with the checkout's root replaced. */
export function packRaw(from, to, repoRoot) {
  const { href, dir } = roots(repoRoot);
  // shards run on separate machines: a shared name (pid and time) would let one overwrite another's in the merge
  const batch = randomUUID();
  mkdirSync(to, { recursive: true });
  let count = 0;
  for (const name of readdirSync(from).filter((f) => f.endsWith('.json'))) {
    const text = JSON.stringify(ownScripts(JSON.parse(readFileSync(path.join(from, name), 'utf8')), repoRoot));
    writeFileSync(path.join(to, `${batch}-${name}`), text.replaceAll(href, URL_ROOT).replaceAll(dir, PATH_ROOT));
    count++;
  }
  return count;
}

/**
 * Copy packed files from `from` into c8's temp directory `to`, with this checkout's root put back. Refuses two
 * compilations of one file (a .tsx compiled by another loader in some shard): c8 would merge their V8 ranges into
 * functions and branches neither has, so the report could pass or fail the change for code that does not exist.
 */
export function unpackRaw(from, to, repoRoot) {
  const { href, dir } = roots(repoRoot);
  mkdirSync(to, { recursive: true });
  /** @type {Map<string, string>} each source-mapped script's compiled line lengths and mappings, by URL */
  const compiled = new Map();
  let count = 0;
  for (const name of readdirSync(from).filter((f) => f.endsWith('.json'))) {
    const text = readFileSync(path.join(from, name), 'utf8');
    for (const [url, entry] of Object.entries(JSON.parse(text)['source-map-cache'] ?? {})) {
      const compilation = JSON.stringify([entry.lineLengths, entry.data?.mappings]);
      if (compiled.has(url) && compiled.get(url) !== compilation) {
        throw new Error(
          `${url.replace(`${URL_ROOT}/`, '')} was compiled differently in two test processes; their coverage cannot be merged.`,
        );
      }
      compiled.set(url, compilation);
    }
    // A merged run owns these scratch copies; keep the V8 coverage-* shape for verified post-report cleanup.
    writeFileSync(path.join(to, `coverage-${name}`), text.replaceAll(URL_ROOT, href).replaceAll(PATH_ROOT, dir));
    count++;
  }
  return count;
}
