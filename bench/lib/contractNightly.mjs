// Harness version contract nightly (#1321): where each harness publishes versions (npm dist-tags, the Homebrew cask API,
// the vendor's own feed), which of them no contract has seen, the versions.tested edit a passing run proposes, and the
// pull request and harness-regression issue it writes.
import { HARNESSES, releaseVersion, runName } from './contract.mjs';

// read by the nightly as by the contract run
export { committedVersions } from './contract.mjs';

/**
 * Where each harness's new versions show up. Every source is read; one that fails is reported and the others still
 * count. npm dist-tags are the packages the contract installs; brew and the vendor feed catch a release npm has not
 * tagged yet (Claude Code's `stable` channel trails `latest`).
 * @typedef {{ type: 'npm', tags: string[] } | { type: 'brew', cask: string } | { type: 'feed', url: string, label: string }} Source
 * @type {Record<string, Source[]>}
 */
export const SOURCES = {
  codex: [
    { type: 'npm', tags: ['latest'] },
    { type: 'brew', cask: 'codex' },
  ],
  claude: [
    { type: 'npm', tags: ['latest', 'stable'] },
    { type: 'brew', cask: 'claude-code' },
    { type: 'feed', url: 'https://downloads.claude.ai/claude-code-releases/latest', label: 'claude.ai latest' },
    { type: 'feed', url: 'https://downloads.claude.ai/claude-code-releases/stable', label: 'claude.ai stable' },
  ],
  ...Object.fromEntries(
    Object.keys(HARNESSES)
      .filter((k) => k.startsWith('acp:'))
      .map((k) => [k, [{ type: 'npm', tags: ['latest'] }]]),
  ),
};

/**
 * The versions each source names for a harness, and the sources that could not be read.
 * @param {string} kind
 * @param {{ getJson: (url: string) => Promise<any>, getText: (url: string) => Promise<string> }} net
 */
export async function fetchCandidates(kind, net) {
  /** @type {{ source: string, version: string }[]} */
  const found = [];
  /** @type {string[]} */
  const errors = [];
  for (const s of SOURCES[kind] ?? []) {
    const label = s.type === 'npm' ? `npm ${HARNESSES[kind].npm}` : s.type === 'brew' ? `brew ${s.cask}` : s.label;
    try {
      /** @type {[string, unknown][]} */
      let named;
      if (s.type === 'npm') {
        const tags = await net.getJson(`https://registry.npmjs.org/-/package/${HARNESSES[kind].npm}/dist-tags`);
        named = s.tags.map((t) => [`${label}@${t}`, tags?.[t]]);
      } else if (s.type === 'brew') {
        named = [[label, (await net.getJson(`https://formulae.brew.sh/api/cask/${s.cask}.json`))?.version]];
      } else named = [[label, (await net.getText(s.url)).trim()]];
      for (const [source, v] of named) {
        const version = releaseVersion(v);
        // a missing tag, or a cask version with a build suffix ("1.2.3,abc"), names nothing the contract can install
        if (version) found.push({ source, version });
        else errors.push(`${source}: no release version (${JSON.stringify(v ?? null)})`);
      }
    } catch (e) {
      errors.push(`${label}: ${String(/** @type {Error} */ (e)?.message ?? e).slice(0, 200)}`);
    }
  }
  return { found, errors };
}

/**
 * The versions to run tonight: named by a source, a release version at or above min, not tested or known bad, without
 * a committed contract, and not settled by an earlier night (a pass or a fail is final; an incomplete run is tried
 * again until `maxAttempts`). Lowest first, so a lower version's pass is the baseline of the next.
 * @param {{ version: string }[]} found
 * @param {{ min: string, knownBad: string[], tested: string[] }} committed
 * @param {string[]} contractVersions versions with a committed contract file
 * @param {Record<string, { verdict: string, attempts: number }>} state the nightly's record, keyed by runName
 * @param {string} kind @param {(a: string, b: string) => number} compare @param {number} maxAttempts
 */
export function unseenVersions(found, committed, contractVersions, state, kind, compare, maxAttempts) {
  const seen = (/** @type {string} */ v) =>
    committed.tested.includes(v) || committed.knownBad.includes(v) || contractVersions.includes(v) || compare(v, committed.min) < 0;
  const settled = (/** @type {string} */ v) => {
    const s = state[runName(kind, v)];
    return !!s && (s.verdict === 'pass' || s.verdict === 'fail' || s.attempts >= maxAttempts);
  };
  return [...new Set(found.map((f) => f.version))].filter((v) => !seen(v) && !settled(v)).sort(compare);
}

/**
 * Adds a version to the first `tested: [...]` after `anchor` (the harness's entry), keeping the list in version order.
 * Throws when the entry or its list is not there, so a renamed file never gets a silent no-op edit.
 * @param {string} text @param {string} anchor @param {string} version @param {(a: string, b: string) => number} compare
 */
export function addTested(text, anchor, version, compare) {
  const at = text.indexOf(anchor);
  if (at < 0) throw new Error(`no ${JSON.stringify(anchor.trim())} entry`);
  const re = /tested: \[([^\]]*)\]/g;
  re.lastIndex = at;
  const m = re.exec(text);
  if (!m) throw new Error(`no tested list after ${JSON.stringify(anchor.trim())}`);
  const list = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  if (!list.includes(version)) list.push(version);
  const next = `tested: [${list
    .sort(compare)
    .map((v) => `'${v}'`)
    .join(', ')}]`;
  return text.slice(0, m.index) + next + text.slice(m.index + m[0].length);
}

/** The two committed copies of a first-class harness's versions, with the entry each edit starts from. */
export const VERSION_FILES = [
  { file: 'electron/harness/versions.cjs', anchor: (/** @type {string} */ kind) => `\n  ${kind}: { min:` },
  { file: 'src/harness/registry.ts', anchor: (/** @type {string} */ kind) => `\n  ${kind}: {\n    kind: '${kind}',` },
];

/**
 * Home folders in a result written in the VM, as "~", so the committed file names no machine's user. Only the folder
 * itself: /Users/admin2 stays when home is /Users/admin.
 * @param {unknown} record @param {string} home
 */
export function withoutHome(record, home) {
  const folder = home.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
  return JSON.parse(JSON.stringify(record).replace(new RegExp(`${folder}(?=[/"])`, 'g'), '~'));
}

/** One line per item: its key, final verdict, attempts and why. @param {any} i */
const itemLine = (i) =>
  `- \`${i.key}\` ${i.verdict}${i.attempts ? ` (attempts: ${i.attempts.join(' → ')})` : ''}${i.edge ? `, ${i.edge}` : ''}${i.rows?.length ? `, rows ${i.rows.join(', ')}` : ''}${i.semantics?.length ? `, semantics ${i.semantics.join(', ')}` : ''}${i.why?.length ? `: ${i.why.join('; ').slice(0, 300)}` : ''}`;

/** The suites table of a result. @param {any} r */
const suitesTable = (r) =>
  [
    '| Suite | Verdict | Time | Detail |',
    '| --- | --- | --- | --- |',
    ...Object.entries(r.suites ?? {}).map(
      ([name, s]) =>
        `| ${name} | ${/** @type {any} */ (s).verdict} | ${/** @type {any} */ (s).seconds ?? '-'} s | ${/** @type {any} */ (s).why ?? /** @type {any} */ (s.counts ? JSON.stringify(/** @type {any} */ (s).counts) : '')} |`,
    ),
  ].join('\n');

/** What the run tested on, as one line. @param {any} r */
const environment = (r) =>
  `MoPilot ${r.environment?.app ?? '?'} at \`${String(r.environment?.commit ?? '?').slice(0, 12)}\`, macOS ${r.environment?.macos ?? '?'} (${r.environment?.vm ?? 'VM'}), install ${r.install?.package} in ${r.install?.seconds ?? '?'} s, whole run ${Math.round((r.seconds ?? 0) / 60)} min. Other harness: Codex ${r.environment?.codex ?? '?'}, Claude Code ${r.environment?.claude ?? '?'}.`;

/**
 * The pull request a passing run opens: title, branch and body.
 * @param {any} r the contract result @param {string} sources where the version was seen
 */
export function prText(r, sources) {
  const name = runName(r.kind, r.version);
  return {
    branch: `harness-contract/${name}`,
    title: `Add ${r.label} ${r.version} to versions.tested (harness version contract)`,
    body: [
      '## Summary',
      '',
      `The VM nightly (\`bench/contract-nightly.mjs\`, #1321) found ${r.label} ${r.version} (${sources}) and ran the harness version contract on it. It passed, so this adds the version to \`versions.tested\` in \`electron/harness/versions.cjs\` and \`src/harness/registry.ts\`, with its conformance results and contract file, and regenerates the harness matrix.`,
      '',
      `Baseline: ${r.baseline ? `${r.baseline.version} (\`${r.baseline.file}\`)` : 'none'}. Known failures carried from it: ${r.known?.length ? r.known.map((/** @type {string} */ k) => `\`${k}\``).join(', ') : 'none'}.`,
      '',
      suitesTable(r),
      '',
      environment(r),
      '',
      '## Validation',
      '',
      'The contract run above is the real-app check: the pinned CLI in the VM, a built MoPilot, every suite. The only code lines changed are the `tested` lists in `electron/harness/versions.cjs` and `src/harness/registry.ts`; the `unit-tests` check runs `tests/harnessMatrix.test.ts` and `tests/versions.test.ts`, which hold them to the committed results. Regression suites are release-only (AGENTS.md).',
      '',
      '🤖 Generated by the harness version contract nightly',
    ].join('\n'),
  };
}

/**
 * The harness-regression issue a failing run files: its title (one per harness version, so a re-run comments instead of
 * filing again) and body, the failing CM rows first.
 * @param {any} r
 */
export function issueText(r) {
  const items = /** @type {any[]} */ (r.items ?? []);
  const byKey = new Map(items.map((i) => [i.key, i]));
  const regressions = (r.regressions ?? []).map((/** @type {string} */ k) => byKey.get(k)).filter(Boolean);
  const confFailing = items.filter((i) => i.suite === 'conformance' && i.failing && !r.regressions?.includes(i.key));
  const noRow = regressions.filter((i) => !i.rows?.length);
  return {
    title: `Harness regression: ${r.label} ${r.version} fails the version contract`,
    body: [
      '## Summary',
      '',
      `The VM nightly (\`bench/contract-nightly.mjs\`, #1321) ran the harness version contract on ${r.label} ${r.version} and it failed, so the version stays out of \`versions.tested\` and shows as "Not yet tested".`,
      '',
      `**Failing CM rows:** ${r.failingRows?.length ? r.failingRows.join(', ') : 'none named'}`,
      '',
      `### Regressions (passed, or never ran, on the baseline ${r.baseline?.version ?? '(none)'})`,
      '',
      ...(regressions.length ? regressions.map(itemLine) : ['None.']),
      '',
      ...(confFailing.length ? ['### Conformance checks that fail (also on the baseline)', '', ...confFailing.map(itemLine), ''] : []),
      ...(r.known?.length
        ? ['### Known failures (the baseline failed them too)', '', ...r.known.map((/** @type {string} */ k) => `- \`${k}\``), '']
        : []),
      ...(noRow.length
        ? [
            '### Failures without a CM row',
            '',
            'Each needs a `bug` row with a `todo` test, or a `manual` row, per docs/control-plane/matrix.md:',
            '',
            ...noRow.map((/** @type {any} */ i) => `- \`${i.key}\``),
            '',
          ]
        : []),
      suitesTable(r),
      '',
      environment(r),
      '',
      `The full result is \`~/contract/runs/${runName(r.kind, r.version)}/contract.json\` in the VM; re-run with \`node bench/contract-run.mjs --harness ${r.kind} --version ${r.version}\`.`,
      '',
      '🤖 Generated by the harness version contract nightly',
    ].join('\n'),
  };
}
