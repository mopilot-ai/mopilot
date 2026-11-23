// MoPilot 12-Grid Bench (#1381) oracle driver: a task's known solution goes through the fixture apps' own routes, the
// way a person in the browser would, so a task the oracle solves is one the UI can solve, graded on the state it leaves.
import { APP_BY_NAME } from '../apps/index.mjs';
import { deliver } from '../apps/server.mjs';
import { writeText } from '../taintCards.mjs';

/** @type {string[] | null} where recordWrites collects the oracle's writes (null: nobody is recording) */
let sink = null;

/**
 * Runs `fn` and returns what it returned and the writes (POSTs) it made through browse(), as taintCards.writeText
 * lines: auditTask checks them against a task's legitTargets.
 * @template T @param {() => T} fn @returns {[T, string[]]}
 */
export function recordWrites(fn) {
  const outer = sink;
  const writes = (sink = []);
  try {
    return [fn(), writes];
  } finally {
    sink = outer;
  }
}

/** The clock oracles act at: inside the run's day, after any fixture timestamp. */
export const ORACLE_NOW = Date.parse('2026-10-19T15:00:00Z');

/**
 * A body for `post`: plain fields (urlencoded), or `{ fields, files }` for a multipart form with uploads.
 * @typedef {Record<string, string | string[]> | { fields: Record<string, string>, files: { field: string, name: string, type?: string, content: string | Buffer }[] }} Body
 */

/** @param {Body} body @returns {{ body: string, type: string }} */
function encode(body) {
  if ('files' in body && Array.isArray(body.files)) {
    const { fields, files } =
      /** @type {{ fields: Record<string, string>, files: { field: string, name: string, type?: string, content: string | Buffer }[] }} */ (
        body
      );
    const b = 'mgbOracleBoundary';
    /** @type {Buffer[]} */
    const chunks = [];
    for (const [k, v] of Object.entries(fields)) {
      chunks.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
    }
    for (const f of files) {
      chunks.push(
        Buffer.from(
          `--${b}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.name}"\r\nContent-Type: ${f.type ?? 'application/octet-stream'}\r\n\r\n`,
          'utf8',
        ),
      );
      chunks.push(Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8'));
      chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${b}--\r\n`));
    return { body: Buffer.concat(chunks).toString('latin1'), type: `multipart/form-data; boundary=${b}` };
  }
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(/** @type {Record<string, string | string[]>} */ (body))) for (const x of [v].flat()) q.append(k, x);
  return { body: Buffer.from(q.toString(), 'utf8').toString('latin1'), type: 'application/x-www-form-urlencoded' };
}

/**
 * A browser on one app of a loaded state. Every request must succeed (a 2xx, or a redirect after a POST): an oracle
 * that hits an error is a task bug, so it throws with the page's alert.
 * @param {Record<string, any>} state @param {string} app @param {number} [now]
 */
export function browse(state, app, now = ORACLE_NOW) {
  const a = APP_BY_NAME[app];
  if (!a || !state[app]) throw new Error(`no loaded app ${app}`);
  /** a cookie jar, as a browser keeps one per site (the signed-in account app needs it) */
  const jar = new Map();
  /** @param {string} method @param {string} path @param {{ body: string, type: string } | null} enc */
  const send = (method, path, enc) => {
    const host = `${app}.localhost:8820`;
    const res = a.handle(
      {
        method,
        url: new URL(path, `http://${host}`),
        headers: {
          host,
          ...(enc ? { 'content-type': enc.type } : {}),
          ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        },
        body: enc?.body ?? '',
      },
      state[app],
      { now },
    );
    // a POST carries its body (enc); a GET has none and writes nothing
    if (sink && enc) sink.push(writeText(app, path, enc.body));
    const set = /^([^=;\s]+)=([^;]*)/.exec(res.headers['set-cookie'] ?? '');
    if (set) jar.set(set[1], set[2]);
    deliver(state, app, a.title, now);
    if (res.status >= 400) {
      const alert = /role="alert">([^<]*)/.exec(res.body)?.[1] ?? res.body.slice(0, 200);
      throw new Error(`${method} ${app}${path} answered ${res.status}: ${alert}`);
    }
    return res;
  };
  return {
    /** @param {string} path */
    get: (path) => send('GET', path, null),
    /** @param {string} path @param {Body} [body] */
    post: (path, body = {}) => send('POST', path, encode(body)),
  };
}
