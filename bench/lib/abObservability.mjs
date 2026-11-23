// ab-compare's observability rows (G5, #3571): for each developer capability, what MoPilot's devtools tool and agent-browser's command produced on the observe fixture, and whether each found what the fixture plants.

/**
 * The capabilities compared: our tool, agent-browser's command, and what a pass must show on fixture/observe.html
 * (an image without alt, an unlabeled input, a fetch of api.json with a cookie header, a layout shift).
 */
export const CAPABILITIES = Object.freeze([
  { id: 'vitals', title: 'Web Vitals', ours: 'browser_vitals', ab: ['vitals', '--json'] },
  { id: 'a11y', title: 'Accessibility audit', ours: 'browser_accessibility_audit', ab: ['a11y', '--json'] },
  { id: 'har', title: 'HAR', ours: 'browser_har', ab: ['network', 'har', 'start|stop'] },
  { id: 'trace', title: 'Performance trace', ours: 'browser_perf_trace', ab: ['trace', 'start|stop'] },
  { id: 'record', title: 'Video', ours: 'browser_record', ab: ['record', 'start|stop'] },
  { id: 'react', title: 'React tree (react.dev)', ours: 'browser_react', ab: ['react', 'tree'] },
]);

/** The secret the fixture's request carries: a HAR that keeps it leaks it. */
export const PLANTED_SECRET = 'sid=planted-secret-cookie';

/**
 * Whether one tool's output for capability `id` shows what the fixture plants. `out`: { text?, file?, bytes?, error? }
 * (text: what the tool printed; file contents read as text for har and trace; bytes: the saved file's size).
 * @returns {{ pass: boolean, note: string }}
 */
export function judge(id, out) {
  // a failed command's message ends with what it printed: its last line says why
  if (out.error) return { pass: false, note: `error: ${String(out.error).trim().split('\n').pop()?.slice(0, 100)}` };
  const text = String(out.text ?? '');
  switch (id) {
    case 'vitals': {
      const ok = /LCP/i.test(text) && /CLS/i.test(text);
      return { pass: ok, note: ok ? 'LCP and CLS reported' : 'no LCP or CLS' };
    }
    case 'a11y': {
      const found = ['image-alt', 'label'].filter((rule) => new RegExp(`\\b${rule}\\b`).test(text));
      return { pass: found.length === 2, note: `found ${found.length ? found.join(', ') : 'none'} of image-alt, label` };
    }
    case 'har': {
      if (!/api\.json/.test(text)) return { pass: false, note: 'the fixture request is missing' };
      const leaked = text.includes(PLANTED_SECRET);
      return { pass: !leaked, note: leaked ? 'the cookie is in the file' : 'request kept, cookie redacted' };
    }
    case 'trace': {
      const ok = /traceEvents|"ph"/.test(text);
      return { pass: ok, note: ok ? `trace saved (${Math.ceil(text.length / 1024)} KB)` : 'no trace events' };
    }
    case 'record': {
      const bytes = out.bytes ?? 0;
      return bytes > 0 ? { pass: true, note: `video saved (${Math.ceil(bytes / 1024)} KB)` } : { pass: false, note: 'no video file' };
    }
    case 'react': {
      // one component per line (agent-browser prints `depth id parent name` rows under `#` comments): a handful on a real React site
      const names = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length;
      return names >= 5 ? { pass: true, note: `${names} components listed` } : { pass: false, note: `${names} components listed` };
    }
    default:
      return { pass: false, note: `unknown capability ${id}` };
  }
}

/** The report rows: one per capability, both tools judged. `results`: id -> { ours, ab } outputs. */
export function observabilityRows(results) {
  return CAPABILITIES.map((c) => ({
    id: c.id,
    title: c.title,
    tool: c.ours,
    command: c.ab.join(' '),
    ours: judge(c.id, results[c.id]?.ours ?? { error: 'not run' }),
    ab: judge(c.id, results[c.id]?.ab ?? { error: 'not run' }),
  }));
}

/** The rows as the markdown table posted with the report. */
export function observabilityMarkdown(rows) {
  const mark = (r) => (r.pass ? 'PASS' : 'FAIL');
  const L = ['**Observability** (fixture/observe.html)', '', '| capability | ours | agent-browser |', '|---|---|---|'];
  for (const r of rows)
    L.push(`| ${r.title} | ${mark(r.ours)} \`${r.tool}\` (${r.ours.note}) | ${mark(r.ab)} \`${r.command}\` (${r.ab.note}) |`);
  const ours = rows.filter((r) => r.ours.pass).length;
  const ab = rows.filter((r) => r.ab.pass).length;
  L.push('', `Parity: ours ${ours}/${rows.length}, agent-browser ${ab}/${rows.length}.`, '');
  return L.join('\n');
}
