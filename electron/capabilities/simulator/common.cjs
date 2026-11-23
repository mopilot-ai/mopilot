// Shared checks and formatting for the simulator tools: argument validation, PNG size, and bounded text.
const { ToolError } = require('../contract/registry.cjs');

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const SERIAL = /^[A-Za-z0-9._:-]{1,64}$/;
const BUNDLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const PACKAGE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const AVD = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;
const SINCE = /^\d{1,3}[smh]$/;
const KEY = /^(?:[A-Z][A-Z0-9_]{1,63}|\d{1,4})$/;
const MAX_TEXT = 20_000;
const MAX_POINTS = 200;

/** A string argument that must match `re`, else a refusal naming it. */
function matching(value, re, what) {
  const s = String(value ?? '');
  if (!re.test(s)) throw new ToolError(`${what} "${s.slice(0, 80)}" is not valid`, 'bad_args');
  return s;
}

/** A screen coordinate: a finite number from 0 to 20000. */
function coord(value, what) {
  const n = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n) || n < 0 || n > 20_000)
    throw new ToolError(`${what} must be a number from 0 to 20000`, 'bad_args');
  return Math.round(n);
}

/** The points of a touch path as integers; at least two, at most MAX_POINTS. */
function pathOf(points) {
  if (!Array.isArray(points) || points.length < 2 || points.length > MAX_POINTS)
    throw new ToolError(`points must list 2 to ${MAX_POINTS} {x, y} points`, 'bad_args');
  return points.map((p, i) => ({ x: coord(p?.x, `points[${i}].x`), y: coord(p?.y, `points[${i}].y`) }));
}

/** The width and height of a PNG from its header, or null. */
function pngSize(buf) {
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** The last `lines` lines of `text` (default 200, at most 1000), with a note when earlier ones were left out. */
function tail(text, lines, what = 'lines') {
  const all = String(text).split('\n');
  if (all[all.length - 1] === '') all.pop();
  const n = Math.min(Math.max(Math.trunc(Number(lines)) || 200, 1), 1000);
  const cut = all.length > n ? `[${all.length - n} earlier ${what} left out]\n` : '';
  return (cut + all.slice(-n).join('\n')).slice(-MAX_TEXT) || '(no output)';
}

/** The first line of a failed command's output, for a refusal. */
const why = (r) =>
  (
    String(r.stderr || r.stdout || `exit ${r.code}`)
      .trim()
      .split('\n')[0] || 'failed'
  ).slice(0, 300);

module.exports = { UDID, SERIAL, BUNDLE, PACKAGE, AVD, SINCE, KEY, MAX_TEXT, matching, coord, pathOf, pngSize, tail, why };
