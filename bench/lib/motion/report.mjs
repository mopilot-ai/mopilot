// Motion bench report (#3810): the vendor / MoPilot / delta table per moment, the per-move alignment table against the numeric tolerance, and an HTML page that overlays the two recordings' paths and progress per move.
import { ALIGN_TOLERANCE, alignAnalyses, compareAnalyses } from './align.mjs';

const cell = (/** @type {number} */ v, /** @type {string} */ unit) => `${v}${unit ? ` ${unit}` : ''}`;
const signed = (/** @type {number} */ v) => `${v > 0 ? '+' : ''}${v}`;
const escape = (/** @type {string} */ s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * The comparison of one moment: the scalar table and the per-move alignment.
 * @param {string} moment @param {any} vendor @param {any} ours @param {Partial<typeof ALIGN_TOLERANCE>} [tolerance]
 */
export function momentReport(moment, vendor, ours, tolerance) {
  const moves = alignAnalyses(vendor, ours, tolerance);
  const compared = moves.filter((m) => m.aligned !== null);
  return {
    moment,
    rows: compareAnalyses(vendor, ours),
    moves,
    appear: { vendor: vendor?.appear ?? null, ours: ours?.appear ?? null },
    alignedShare: compared.length ? Math.round((compared.filter((m) => m.aligned).length / compared.length) * 1000) / 1000 : null,
  };
}

/** The appear-at-target rows of a report (what each cursor shows before a click): label, unit, and where in `appear` the median sits. */
export const APPEAR_ROWS = /** @type {[string, string, (a: any) => any][]} */ ([
  ['Clicks with an episode / usable', '', (a) => `${a.found}/${a.usable} of ${a.clicks}`],
  ['Visible before the click (p50 / p95)', 'ms', (a) => `${a.visibleBeforeMs.p50} / ${a.visibleBeforeMs.p95}`],
  ['Start distance to the dot (p50 / p95)', 'px', (a) => `${a.startDistance.p50} / ${a.startDistance.p95}`],
  ['Travel time (p50 / p95)', 'ms', (a) => `${a.travelMs.p50} / ${a.travelMs.p95}`],
  ['Straightness (p50)', '', (a) => a.straightness.p50],
  ['Peak speed at (p50 of travel)', '', (a) => a.peakFraction.p50],
  ['Disc settled before the click (p50)', 'ms', (a) => a.discOnsetMs.p50],
  ['Gone after the click (p50 / p95)', 'ms', (a) => `${a.lingerMs.p50} / ${a.lingerMs.p95}`],
  ['Planner rms (p50)', 'px', (a) => a.plan.rmsPx.p50],
  ['Planner duration ratio (p50)', '', (a) => a.plan.durationRatio.p50],
  ['Spring fit response / damping (p50)', '', (a) => `${a.spring.response.p50} / ${a.spring.damping.p50}`],
]);

/**
 * The reports as a markdown text: per moment, the scalar table, then the aligned moves with what failed.
 * @param {ReturnType<typeof momentReport>[]} reports @param {{ vendor: string, ours: string, tolerance?: Partial<typeof ALIGN_TOLERANCE> }} o
 */
export function formatReport(reports, { vendor, ours, tolerance = {} }) {
  const tol = { ...ALIGN_TOLERANCE, ...tolerance };
  const lines = [
    `Aligned when: path RMS <= ${tol.pathRmsPx} px, duration within ${Math.round(tol.durationShare * 100)}%, per-frame position error p95 <= ${tol.frameErrorP95Px} px, timing offset <= ${tol.offsetFrames} frame at 60 Hz.`,
    '',
  ];
  for (const r of reports) {
    lines.push(`## ${r.moment}`, '', `| Metric | ${vendor} | ${ours} | Delta | Verdict |`, '| --- | ---: | ---: | ---: | --- |');
    for (const row of r.rows.filter((x) => x.verdict !== 'n/a')) {
      lines.push(
        `| ${row.label} | ${cell(/** @type {number} */ (row.vendor), row.unit)} | ${cell(/** @type {number} */ (row.ours), row.unit)} | ${signed(/** @type {number} */ (row.delta))}${row.deltaPct === null ? '' : ` (${signed(row.deltaPct)}%)`} | ${row.verdict} |`,
      );
    }
    if (r.appear.vendor || r.appear.ours) {
      const show = (/** @type {any} */ a, /** @type {(a: any) => any} */ f) => (a ? f(a) : '—');
      lines.push('', `| Appear at target | ${vendor} | ${ours} |`, '| --- | ---: | ---: |');
      for (const [label, unit, f] of APPEAR_ROWS)
        lines.push(`| ${label}${unit ? ` (${unit})` : ''} | ${show(r.appear.vendor, f)} | ${show(r.appear.ours, f)} |`);
    }
    if (r.moves.length) {
      lines.push(
        '',
        `Moves aligned: ${r.alignedShare === null ? '—' : `${Math.round(r.alignedShare * 100)}%`}`,
        '',
        '| Move | Path RMS | Duration | Frame error p95 | Offset | Aligned |',
        '| --- | ---: | ---: | ---: | ---: | --- |',
      );
      for (const m of r.moves) {
        if (m.aligned === null) lines.push(`| ${m.key} | — | — | — | — | missing on one side |`);
        else {
          const bad = Object.entries(m.checks)
            .filter(([, ok]) => !ok)
            .map(([k]) => k);
          lines.push(
            `| ${m.key} | ${m.pathRmsPx} px | ${Math.round(m.durationShare * 1000) / 10}% | ${m.frameErrorP95Px} px | ${m.offsetFrames} fr | ${m.aligned ? 'yes' : `no (${bad.join(', ')})`} |`,
          );
        }
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** An SVG line chart of series over a box; `points` are [x, y] in data units. */
function chart(
  /** @type {{ points: number[][], color: string, name: string }[]} */ series,
  /** @type {string} */ xLabel,
  /** @type {string} */ yLabel,
) {
  const all = series.flatMap((s) => s.points);
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const w = 320;
  const h = 200;
  const pad = 28;
  const px = (/** @type {number} */ x) => pad + ((x - x0) / (x1 - x0 || 1)) * (w - 2 * pad);
  const py = (/** @type {number} */ y) => h - pad - ((y - y0) / (y1 - y0 || 1)) * (h - 2 * pad);
  const lines = series
    .map(
      (s) =>
        `<polyline fill="none" stroke="${s.color}" stroke-width="1.5" points="${s.points.map((p) => `${px(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`).join(' ')}"/>${s.points.map((p) => `<circle cx="${px(p[0]).toFixed(1)}" cy="${py(p[1]).toFixed(1)}" r="1.8" fill="${s.color}"/>`).join('')}`,
    )
    .join('');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"><rect x="${pad}" y="${pad}" width="${w - 2 * pad}" height="${h - 2 * pad}" fill="none" stroke="#bbb"/>${lines}<text x="${w / 2}" y="${h - 6}" font-size="10" text-anchor="middle">${escape(xLabel)}</text><text x="8" y="${h / 2}" font-size="10" transform="rotate(-90 8 ${h / 2})" text-anchor="middle">${escape(yLabel)}</text></svg>`;
}

/**
 * Two paths of one move overlaid: the drawn path in the chord frame (u along, v across) and the distance covered over time (u against ms).
 * @param {number[][]} vendorPath @param {number[][]} oursPath
 */
export function overlaySvg(vendorPath, oursPath) {
  const shape = (/** @type {number[][]} */ p) => p.map(([, u, v]) => [u, v]);
  const time = (/** @type {number[][]} */ p) => p.map(([t, u]) => [t, u]);
  return [
    chart(
      [
        { points: shape(vendorPath), color: '#1f77b4', name: 'vendor' },
        { points: shape(oursPath), color: '#e8590c', name: 'ours' },
      ],
      'u (px along the chord)',
      'v (px across)',
    ),
    chart(
      [
        { points: time(vendorPath), color: '#1f77b4', name: 'vendor' },
        { points: time(oursPath), color: '#e8590c', name: 'ours' },
      ],
      'ms from the move start',
      'u (px)',
    ),
  ].join('');
}

/**
 * One HTML page of every moment's moves overlaid (vendor blue, ours orange), with each move's alignment verdict.
 * @param {ReturnType<typeof momentReport>[]} reports @param {{ vendor: string, ours: string }} names
 */
export function overlayHtml(reports, { vendor, ours }) {
  const body = reports
    .map((r) => {
      const items = r.moves
        .filter((m) => m.vendorPath && m.oursPath)
        .map(
          (m) =>
            `<figure><figcaption>${escape(m.key)}: ${m.aligned ? 'aligned' : 'not aligned'}</figcaption>${overlaySvg(m.vendorPath, m.oursPath)}</figure>`,
        )
        .join('');
      return `<h2>${escape(r.moment)}</h2><div class="row">${items || '<p>No move recorded on both sides.</p>'}</div>`;
    })
    .join('');
  return `<!doctype html><meta charset="utf-8"><title>Motion overlay</title><style>body{font:14px sans-serif;margin:16px}.row{display:flex;flex-wrap:wrap;gap:12px}figure{margin:0}figcaption{font-weight:600}.v{color:#1f77b4}.o{color:#e8590c}</style><h1>Cursor motion overlay</h1><p><span class="v">${escape(vendor)}</span> / <span class="o">${escape(ours)}</span></p>${body}`;
}
