// Benchmark task catalogs read from the external checkouts (WebGames, REAL, MacArena), and the SMOKE and FULL tiers.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { externalPaths } from './external.mjs';

/** The SMOKE tier: a fixed sample per benchmark, small enough to run every arm in about two hours. */
export const SMOKE = {
  wg: [
    'key-combo',
    'menu-navigator',
    'button-hold',
    'stock-market',
    'text-mirror',
    'chart-read-easy',
    'wolf-goat-cabbage',
    'recipe-calculator',
    'iframe-nest-easy',
    'calendar-comprehension',
    'click-pixel',
    'datehard',
  ],
  real: [
    'gomail-16',
    'gomail-24',
    'gocalendar-12',
    'gocalendar-23',
    'udriver-14',
    'networkin-27',
    'topwork-14',
    'omnizon-17',
    'dashdish-7',
    'opendining-12',
  ],
  mac: ['a13331ed', '4f0d1950', '7bcb0652', 'e7480f08', '24f5dc8b'],
};

/** Parses WebGames' task catalog (one JSON object per line). @param {string} text */
export function parseWebGames(text) {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const t = JSON.parse(l);
      return { id: t.id, path: t.path, description: t.description, password: t.password };
    });
}

/** One REAL v2 task file, reduced to what the runner needs. @param {any} t */
export function parseRealTask(t) {
  return { id: t.id, goal: t.goal, url: String(t.website.url).replace(/\/+$/, ''), grader: t.evals[0].script };
}

/** A MacArena task, keyed by the first 8 characters of its id (how results name it). @param {any} t */
export const macKey = (t) => String(t.id).slice(0, 8);

/**
 * The catalog of one benchmark, from the external checkouts: tasks with an `id` (MacArena: the 8-character key) and
 * everything the drivers need.
 * @param {'wg' | 'real' | 'mac'} bench
 * @param {string} external
 */
export function loadCatalog(bench, external) {
  const p = externalPaths(external);
  const need = (f) => {
    if (!existsSync(f)) throw new Error(`missing ${f}: run node bench/setup-external.mjs first (bench/README.md)`);
    return f;
  };
  if (bench === 'wg') return parseWebGames(readFileSync(need(p.webgamesCatalog), 'utf8'));
  if (bench === 'real') {
    return readdirSync(need(p.realTasks))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => parseRealTask(JSON.parse(readFileSync(path.join(p.realTasks, f), 'utf8'))));
  }
  const out = [];
  for (const dir of readdirSync(need(p.macarenaTasks)).sort()) {
    const d = path.join(p.macarenaTasks, dir);
    for (const f of readdirSync(d).sort()) {
      const t = JSON.parse(readFileSync(path.join(d, f), 'utf8'));
      out.push({ ...t, fullId: t.id, id: macKey(t), category: dir });
    }
  }
  return out;
}

/**
 * The tasks a run covers, in order: the ones named, else the tier's list (FULL: the whole catalog). Every id must
 * be in the catalog.
 * @template {{ id: string }} T
 * @param {{ bench: 'wg' | 'real' | 'mac', tier: string, tasks: string[] }} cfg
 * @param {T[]} catalog
 * @returns {T[]}
 */
export function selectTasks(cfg, catalog) {
  const ids = cfg.tasks.length ? cfg.tasks : cfg.tier === 'full' ? catalog.map((t) => t.id) : SMOKE[cfg.bench];
  const byId = new Map(catalog.map((t) => [t.id, t]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`not in the ${cfg.bench} catalog: ${missing.join(', ')}`);
  return ids.map((id) => /** @type {T} */ (byId.get(id)));
}
