// Version ordering shared by main and renderer: compare numeric release components and prerelease identifiers.
import { compareVersionParts, parseExactVersion } from './exactSemver.mjs';

/** @param {unknown} a @param {unknown} b @returns {number} */
export function compareVersions(a, b) {
  const exactA = parseExactVersion(a),
    exactB = parseExactVersion(b);
  if (exactA && exactB) return compareVersionParts(exactA, exactB);
  // Harness detection also accepts incomplete or unreadable CLI versions; retain its lenient fallback.
  const split = (/** @type {unknown} */ v) => {
    const [core, pre] = String(v).trim().replace(/^v/, '').split(/-(.*)/s);
    return { core: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre ? pre.split('.') : [] };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) < (y.core[i] ?? 0) ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
