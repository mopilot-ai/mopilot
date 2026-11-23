// Harness version contract (#1321): each suite's output as items (what ran, how it ended, the CM rows behind it) and a
// suite verdict: the control-matrix TAP summary, the conformance results file, the edge records and the ACP admission.
import { CHECKS_FOR } from '../../scripts/gen-matrix.mjs';
import { SCENARIOS } from './edge.mjs';

/**
 * The edge scenarios and the CM rows of each, read from docs/control-plane/edge-cases.md: a row's last column names
 * its scenarios in backticks and its catalog rows as CM-…; the scenario keeps its row's E- id as well.
 * @param {string} markdown
 * @returns {Map<string, { edge: string, rows: string[] }>}
 */
export function edgeRows(markdown) {
  const ids = new Set(SCENARIOS.map((s) => s.id));
  /** @type {Map<string, { edge: string, rows: string[] }>} */
  const out = new Map();
  for (const line of String(markdown).split('\n')) {
    const cols = line.split('|').map((c) => c.trim());
    if (cols.length < 4 || !/^E-[A-Z]+\d+[a-z]?$/.test(cols[1])) continue;
    const last = cols[cols.length - 2];
    const rows = [...last.matchAll(/\bCM-[A-Z]\d+[a-z]?\b/g)].map((m) => m[0]);
    for (const [, id] of last.matchAll(/`([\w-]+)`/g)) if (ids.has(id) && !out.has(id)) out.set(id, { edge: cols[1], rows });
  }
  return out;
}

/** The semantics each conformance check backs (scripts/gen-matrix.mjs CHECKS_FOR), for a harness. @param {string} kind */
export function checkSemantics(kind) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const [semantic, ids] of Object.entries(/** @type {Record<string, Record<string, string[]>>} */ (CHECKS_FOR)[kind] ?? {}))
    for (const id of ids) out.set(id, [...(out.get(id) ?? []), semantic]);
  return out;
}

/**
 * One item of a suite: what ran, how it ended, and the rows behind it. `failing` items are what a verdict weighs;
 * `ungradable` ones make the run incomplete instead.
 * @typedef {{ key: string, suite: string, id: string, cell?: string, verdict: string, failing: boolean,
 *   ungradable?: boolean, why?: string[], edge?: string, rows: string[], semantics?: string[], attempts?: string[] }} Item
 */

/** A suite's verdict from its items: error when it could not run, else fail when any item fails. @param {Item[]} items */
const suiteVerdict = (items) => (items.some((i) => i.failing) ? 'fail' : 'pass');

/**
 * The control-matrix unit suite from its TAP summary ("# pass 812", "# fail 0").
 * @param {{ code: number | null, stdout: string }} run
 */
export function summarizeControlMatrix(run) {
  const n = (/** @type {string} */ k) => Number(new RegExp(`^# ${k} (\\d+)$`, 'm').exec(run.stdout)?.[1] ?? NaN);
  const pass = n('pass');
  // a cancelled test (a file that timed out) did not run, so it counts as failed
  const fail = n('fail') + (n('cancelled') || 0);
  if (Number.isNaN(pass) || Number.isNaN(fail)) return { verdict: 'error', why: `no TAP summary (exit ${run.code})`, items: [] };
  const failed = [...run.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  /** @type {Item[]} */
  const items = failed.map((title) => {
    const row = /^(CM-[A-Z]\d+[a-z]?)\b/.exec(title)?.[1];
    return { key: `controlMatrix:${title}`, suite: 'controlMatrix', id: title, verdict: 'fail', failing: true, rows: row ? [row] : [] };
  });
  return { verdict: fail > 0 || run.code !== 0 ? 'fail' : 'pass', pass, fail, items };
}

/**
 * The conformance run from its results file (tests/conformance/README.md): fail and error are failing; partial and
 * skip are not (scripts/gen-matrix.mjs cleanVersion counts the same way). A check the harness has that is not in the
 * file never ran (the runner stopped early), so the suite is an error rather than a pass on what did run.
 * @param {string} kind
 * @param {{ cli?: string, checks?: { id: string, title?: string, verdict: string, observed?: { mismatches?: string[], error?: string } }[] } | null} file
 * @param {string[]} [expected] the check ids the harness has (tests/conformance/<harness>/)
 */
export function summarizeConformance(kind, file, expected = /** @type {string[]} */ ([])) {
  if (!file || !Array.isArray(file.checks)) return { verdict: 'error', why: 'no conformance results file', items: [] };
  const sem = checkSemantics(kind);
  /** @type {Record<string, number>} */
  const counts = {};
  /** @type {Item[]} */
  const items = file.checks.map((c) => {
    counts[c.verdict] = (counts[c.verdict] ?? 0) + 1;
    const failing = c.verdict === 'fail' || c.verdict === 'error';
    const why = c.observed?.mismatches ?? (c.observed?.error ? [c.observed.error] : undefined);
    return {
      key: `conformance:${c.id}`,
      suite: 'conformance',
      id: c.id,
      verdict: c.verdict,
      failing,
      ...(failing && why ? { why } : {}),
      rows: [],
      semantics: sem.get(c.id) ?? [],
    };
  });
  const cli = file.cli ?? null;
  const missing = expected.filter((id) => !items.some((i) => i.id === id));
  if (missing.length) return { verdict: 'error', why: `checks that did not run: ${missing.join(', ')}`, cli, counts, items };
  return { verdict: suiteVerdict(items), cli, counts, items };
}

/**
 * The edge suite from its records (bench/edge-run.mjs): FAIL and DEAD-END are failing, UNGRADABLE makes the run
 * incomplete.
 * @param {{ scenario: string, cell: string, verdict: string, why?: string[], wallMs?: number | null }[]} records
 * @param {Map<string, { edge: string, rows: string[] }>} rows
 */
export function summarizeEdge(records, rows) {
  /** @type {Record<string, number>} */
  const counts = {};
  /** @type {Item[]} */
  const items = records.map((r) => {
    counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
    const failing = r.verdict === 'FAIL' || r.verdict === 'DEAD-END';
    const ungradable = r.verdict === 'UNGRADABLE';
    const meta = rows.get(r.scenario);
    return {
      key: `edge:${r.cell}:${r.scenario}`,
      suite: 'edge',
      id: r.scenario,
      cell: r.cell,
      verdict: r.verdict,
      failing,
      ...(ungradable ? { ungradable } : {}),
      ...(r.why?.length ? { why: r.why } : {}),
      ...(meta ? { edge: meta.edge } : {}),
      rows: meta?.rows ?? [],
    };
  });
  if (!items.length) return { verdict: 'error', why: 'no edge records', counts, items };
  return { verdict: items.some((i) => i.ungradable) ? 'error' : suiteVerdict(items), counts, items };
}

/**
 * The ACP admission probe's result for one harness (electron/harness/admission.cjs): admitted passes, a harness that
 * wants a sign-in cannot be judged in the VM, and anything else fails.
 * @param {{ state?: string, version?: string, reason?: string } | null} r
 */
export function summarizeAcp(r) {
  if (!r?.state) return { verdict: 'error', why: 'no admission result', items: [] };
  if (r.state === 'signin') return { verdict: 'error', why: `needs a sign-in in the VM: ${r.reason ?? r.state}`, items: [] };
  const failing = r.state !== 'admitted';
  /** @type {Item[]} */
  const items = [
    {
      key: 'acp:admission',
      suite: 'acp',
      id: 'admission',
      verdict: r.state,
      failing,
      ...(failing ? { why: [r.reason ?? r.state] } : {}),
      rows: [],
    },
  ];
  return { verdict: suiteVerdict(items), version: r.version ?? null, items };
}

/**
 * #1319 G9 as a contract item (tests/conformance/acp/sage-permission.mjs): the harness's permission request for
 * MoPilot's own tool must carry its sage_<nonce> server name, or the user gets two cards. A request that did not
 * fails (with the toolCall's title and _meta, and the transport); a turn that never called the tool proves nothing
 * and makes the run incomplete; a harness that called it without asking passes (no second card either).
 * @param {any} r the check's result file, or null
 * @returns {Item}
 */
export function sagePermissionItem(r) {
  const base = { key: 'acp:sage-permission', suite: 'acp', id: 'sage-permission', rows: [] };
  if (!r) return { ...base, verdict: 'not run', failing: false, ungradable: true, why: ['no sage-permission result'] };
  const failing = r.verdict === 'fail';
  const ungradable = !failing && r.verdict !== 'pass' && r.verdict !== 'no-card';
  const why = failing
    ? (r.requests ?? [])
        .filter((q) => !q.sage)
        .map((q) =>
          `${r.transport}: title ${JSON.stringify(q.toolCall?.title ?? null)}, _meta ${JSON.stringify(q.toolCall?._meta ?? null)}`.slice(
            0,
            300,
          ),
        )
    : ungradable
      ? [r.error ?? 'the turn never called the echo tool']
      : [`${r.verdict} over ${r.transport}`];
  return { ...base, verdict: r.verdict, failing, ...(ungradable ? { ungradable: true } : {}), why };
}
