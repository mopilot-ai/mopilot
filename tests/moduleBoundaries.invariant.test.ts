// The modules keep the layering their boundary.json files declare (docs/architecture/modularization.md §4), as a ratchet:
// each domain's violations are counted here and on the merge base with origin/main, under today's rules, and a change that
// adds one to a domain fails, naming it. A file the change moves (a git rename) carries its base violations to its new
// domain. Today's counts are printed, so a pull request that removes some can quote them.
// The public runner's checkout on main is shallow (tests/shallowCheckout.invariant.test.ts): with only the newest commit
// there is nothing to compare, and the test says it skipped. Anywhere else a base it can't read fails it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  baseTree,
  countByDomain,
  grown,
  isShallow,
  OUTSIDE,
  readBoundaries,
  renamesSince,
  violationsIn,
} from '../scripts/module-boundaries.mjs';

export const GUARDS = ['electron/', 'shared/', 'src/'];

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const git = (args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('no change adds a boundary violation to a domain', (t) => {
  if (isShallow(git)) {
    t.skip('a shallow checkout (main on the public runner) has no merge base to compare with');
    return;
  }
  const boundaries = readBoundaries();
  const here = violationsIn(boundaries);
  const tree = baseTree(git);
  try {
    // a file the change moved is judged on the base where it is now, so the move itself adds nothing
    const then = violationsIn(boundaries, tree.dir, undefined, renamesSince(git, tree.sha));
    const now = countByDomain(here);
    const was = countByDomain(then);
    for (const [domain, n] of Object.entries(now)) t.diagnostic(`${domain}: ${n} (base ${was[domain] ?? 0})`);
    const seen = new Set(then.violations.map((v) => `${v.kind} ${v.from} ${v.to}`));
    const before = new Set(then.unassigned);
    const added = grown(now, was).map(({ domain, now: n, base }) => {
      const fresh =
        domain === OUTSIDE
          ? here.unassigned.filter((f) => !before.has(f)).map((f) => `  outside any domain: ${f}`)
          : here.violations
              .filter((v) => v.domain === domain && !seen.has(`${v.kind} ${v.from} ${v.to}`))
              .map((v) => `  ${v.kind}: ${v.from} → ${v.to}`);
      return `${domain}: ${base} → ${n}\n${fresh.join('\n')}`;
    });
    assert.deepEqual(
      added,
      [],
      'import through the domain’s public entry, from a lower layer, put a new file in a domain, or name an exception in its boundary.json',
    );
  } finally {
    tree.cleanup();
  }
});
