// Scans the resolved production tree of the phone app (mobile/package-lock.json) for licences: fails on a copyleft or unknown one, lists dual and unusual ones for an owner decision, and writes the report.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Licences that need no decision. */
export const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'OFL-1.1']);
/** Permissive or weak-copyleft licences a person decides on once: not refused, never silent. */
export const DECIDE = new Set([
  '0BSD',
  'BlueOak-1.0.0',
  'Unlicense',
  'CC0-1.0',
  'Python-2.0',
  'CC-BY-4.0',
  'MPL-2.0',
  'LGPL-2.1',
  'LGPL-3.0',
]);

/**
 * An SPDX expression as a tree: `{ id }`, `{ op: 'AND' | 'OR', parts }`. Anything that does not parse is one unknown id.
 * @param {string} text
 * @returns {any}
 */
export function parseExpression(text) {
  const tokens = text.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').split(/\s+/).filter(Boolean);
  let at = 0;
  const atom = () => {
    const t = tokens[at++];
    if (t === '(') {
      const inner = or();
      if (tokens[at++] !== ')') throw new Error('unbalanced');
      return inner;
    }
    if (!t || t === ')' || t === 'AND' || t === 'OR') throw new Error('unexpected token');
    return { id: t.replace(/\+$/, '') };
  };
  const chain = (/** @type {'AND' | 'OR'} */ op, /** @type {() => any} */ next) => () => {
    const parts = [next()];
    while (tokens[at] === op) {
      at++;
      parts.push(next());
    }
    return parts.length === 1 ? parts[0] : { op, parts };
  };
  const and = chain('AND', atom);
  const or = chain('OR', and);
  try {
    const tree = or();
    if (at !== tokens.length) throw new Error('trailing');
    return tree;
  } catch {
    return { id: text.trim() || 'UNKNOWN' };
  }
}

/** @param {string} id @returns {'allowed' | 'decide' | 'refused'} anything on neither list (GPL, AGPL, SSPL, an unknown id) is refused */
const rankOf = (id) => (ALLOWED.has(id) ? 'allowed' : DECIDE.has(id) ? 'decide' : 'refused');
const ORDER = { allowed: 0, decide: 1, refused: 2 };

/**
 * How a licence expression stands: the best way to satisfy it. OR takes the most permissive alternative, AND the least.
 * `dual` is set when the choice is the package's own (an OR between two licences).
 * @param {string | undefined} licence
 * @returns {{ status: 'allowed' | 'decide' | 'refused', dual: boolean }}
 */
export function classify(licence) {
  if (typeof licence !== 'string' || !licence.trim()) return { status: 'refused', dual: false };
  const walk = (/** @type {any} */ node) => {
    if (node.id) return { status: rankOf(node.id), dual: false };
    const kids = node.parts.map(walk);
    const pick = node.op === 'OR' ? Math.min : Math.max;
    const status = ['allowed', 'decide', 'refused'][pick(...kids.map((k) => ORDER[/** @type {'allowed'} */ (k.status)]))];
    return { status: /** @type {'allowed' | 'decide' | 'refused'} */ (status), dual: node.op === 'OR' || kids.some((k) => k.dual) };
  };
  return walk(parseExpression(licence));
}

/**
 * Every production package of a v3 lockfile with its licence and standing, sorted by name.
 * @param {{ packages?: Record<string, { version?: string, license?: string, dev?: boolean, link?: boolean }> }} lock
 */
export function scanLock(lock) {
  const rows = Object.entries(lock.packages ?? {})
    .filter(([path, p]) => path.includes('node_modules/') && !p.dev && !p.link)
    .map(([path, p]) => ({
      name: path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length),
      version: p.version ?? '?',
      licence: typeof p.license === 'string' && p.license ? p.license : 'UNKNOWN',
      ...classify(p.license),
    }));
  const seen = new Set();
  const unique = rows.filter((r) => !seen.has(`${r.name}@${r.version}`) && seen.add(`${r.name}@${r.version}`));
  return unique.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** @param {ReturnType<typeof scanLock>} rows */
export function summarize(rows) {
  const by = (/** @type {(r: (typeof rows)[number]) => boolean} */ f) => rows.filter(f);
  const counts = new Map();
  for (const r of rows) counts.set(r.licence, (counts.get(r.licence) ?? 0) + 1);
  return {
    total: rows.length,
    refused: by((r) => r.status === 'refused'),
    decide: by((r) => r.status === 'decide' || (r.status === 'allowed' && r.dual)),
    counts: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  };
}

/** The report a person reads: counts, what needs a decision, then every production dependency. @param {ReturnType<typeof scanLock>} rows */
export function renderReport(rows) {
  const s = summarize(rows);
  const line = (/** @type {(typeof rows)[number]} */ r) => `| ${r.name} | ${r.version} | ${r.licence.replace(/\|/g, '/')} |`;
  const table = (/** @type {typeof rows} */ list) => ['| Package | Version | Licence |', '|---|---|---|', ...list.map(line)].join('\n');
  return [
    '# Phone app licence scan',
    '',
    'Generated by `node scripts/mobile-licence-scan.mjs` from `mobile/package-lock.json` (production packages only; development-only packages are not shipped).',
    '',
    `**Result:** ${s.refused.length ? `FAILED, ${s.refused.length} package(s) with a refused or unknown licence` : 'no refused or unknown licence'}. ${s.total} production packages; ${s.decide.length} need an owner decision.`,
    '',
    '## Counts',
    '',
    '| Licence | Packages |',
    '|---|---|',
    ...s.counts.map(([l, n]) => `| ${l.replace(/\|/g, '/')} | ${n} |`),
    '',
    '## Refused or unknown (blocks a store build)',
    '',
    s.refused.length ? table(s.refused) : 'None.',
    '',
    '## Needs an owner decision',
    '',
    'Not MIT, ISC, BSD, Apache or OFL, or dual-licensed (the package lets the user pick).',
    '',
    s.decide.length ? table(s.decide) : 'None.',
    '',
    '## Every production dependency',
    '',
    table(rows),
    '',
  ].join('\n');
}

/** @param {string[]} argv */
export function main(argv) {
  const arg = (/** @type {string} */ name, /** @type {string} */ fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const rows = scanLock(JSON.parse(readFileSync(arg('--lock', 'mobile/package-lock.json'), 'utf8')));
  const report = renderReport(rows);
  const out = argv.includes('--check') ? null : arg('--report', 'design/phone-on-orca/licence-scan.md');
  if (out) writeFileSync(out, report);
  const s = summarize(rows);
  console.log(
    `${s.total} production packages, ${s.refused.length} refused or unknown, ${s.decide.length} for an owner decision${out ? `; report in ${out}` : ''}`,
  );
  for (const r of s.refused) console.log(`  refused: ${r.name}@${r.version} ${r.licence}`);
  return s.refused.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
