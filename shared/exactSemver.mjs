// Exact app-version parsing and ordering shared by every feed and desktop updater, without numeric identity loss.
/** @param {unknown} value @returns {{ core: bigint[], pre: string[] } | null} */
export function parseExactVersion(value) {
  const match = typeof value === 'string' && /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
  return match ? { core: match.slice(1, 4).map((part) => BigInt(part)), pre: match[4] ? match[4].split('.') : [] } : null;
}

/** @param {{ core: bigint[], pre: string[] }} x @param {{ core: bigint[], pre: string[] }} y @returns {number} */
export function compareVersionParts(x, y) {
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i] ? 1 : -1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i],
      q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p),
      qn = /^\d+$/.test(q);
    if (pn && qn) {
      const a = BigInt(p),
        b = BigInt(q);
      if (a !== b) return a < b ? -1 : 1;
      continue;
    }
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
