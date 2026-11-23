// MoPilot 12-Grid Bench (#1381) fixture-app kit: escaped HTML templates and the shared page frame, request bodies
// (urlencoded, JSON, multipart uploads), responses, routes, paging, record ids and the event log every app keeps.

/** @typedef {{ method: string, url: URL, headers: Record<string, string | string[] | undefined>, body: string }} Req */
/** @typedef {{ status: number, headers: Record<string, string>, body: string, encoding?: 'latin1' }} Res body as text, or bytes (latin1) */
/** @typedef {{ name: string, data: string, type: string, size: number }} Upload a file, its bytes in base64 */

/** Escapes text for HTML content and attribute values. @param {unknown} s */
export const esc = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** Markup that `html` inserts as is. @param {unknown} s */
export const raw = (s) => ({ __html: String(s ?? '') });

/** @param {unknown} v @returns {string} */
const part = (v) => {
  if (Array.isArray(v)) return v.map(part).join('');
  if (v && typeof v === 'object' && '__html' in v) return /** @type {any} */ (v).__html;
  if (v === false || v === null || v === undefined) return '';
  return esc(v);
};

/** A template whose values are escaped (arrays joined, `raw` kept, false/null/undefined dropped); returns `raw`. */
export function html(/** @type {TemplateStringsArray} */ strings, /** @type {unknown[]} */ ...vals) {
  return raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? part(vals[i]) : ''), ''));
}

const CSS = `body{font:14px/1.45 -apple-system,system-ui,sans-serif;margin:0;color:#1d1d1f;background:#f6f6f7}
header{background:#24292f;color:#fff;padding:10px 20px;display:flex;gap:18px;align-items:center}
header a{color:#d0d7de;text-decoration:none}header strong{font-size:16px;margin-right:12px}
main{max-width:1100px;margin:18px auto;padding:0 20px}table{border-collapse:collapse;width:100%;background:#fff}
th,td{border-bottom:1px solid #e5e5e5;padding:7px 9px;text-align:left;vertical-align:top}th{background:#fafafa}
.flash{background:#e6f4ea;border:1px solid #a8dab5;padding:8px 12px;margin-bottom:12px}
.error{background:#fdecea;border:1px solid #f5b5ae;padding:8px 12px;margin-bottom:12px}
form.inline{display:inline}label{display:block;margin:8px 0 2px}input,select,textarea{font:inherit;padding:5px}
textarea{width:100%;min-height:140px}.muted{color:#6e6e73}.pager a{margin-right:8px}.unread td{font-weight:600}
.card{background:#fff;border:1px solid #e5e5e5;padding:14px;margin-bottom:12px}pre.body{white-space:pre-wrap;font:inherit}`;

/**
 * The page frame every app shares: its name, a nav bar, an optional notice and the content.
 * @param {{ app: string, title: string, nav?: [string, string][], flash?: string | null, error?: string | null, body: unknown }} o
 */
export function page({ app, title, nav = [], flash, error, body }) {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} · ${app}</title>
<style>${raw(CSS)}</style></head><body><header><strong>${app}</strong>${nav.map(([href, label]) => html`<a href="${href}">${label}</a>`)}</header>
<main>${flash ? html`<div class="flash" role="status">${flash}</div>` : ''}${error ? html`<div class="error" role="alert">${error}</div>` : ''}${body}</main></body></html>`
    .__html;
}

/** @param {string} body @param {Record<string, string>} [headers] @returns {Res} */
export const ok = (body, headers = {}) => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers }, body });
/** After a POST: see the result at `location` (POST-redirect-GET). @param {string} location @returns {Res} */
export const redirect = (location) => ({ status: 303, headers: { location }, body: '' });
/** @param {unknown} value @returns {Res} */
export const json = (value, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
/** @param {string} [what] @returns {Res} */
export const notFound = (what = 'Not found') => ({ status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: what });
/**
 * A Content-Disposition value any file name can go in: an ASCII fallback plus the UTF-8 name (RFC 6266/5987), with
 * quotes and line breaks dropped, so a name an agent uploaded can never break the response header.
 * @param {'attachment' | 'inline'} kind @param {string} name
 */
export function disposition(kind, name) {
  const clean = name.replace(/[\r\n"\\]/g, '');
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  return `${kind}; filename="${ascii}"${ascii === clean ? '' : `; filename*=UTF-8''${encodeURIComponent(clean)}`}`;
}

/** A text file the browser saves (sent as UTF-8). @param {string} name @param {string} type @param {string} body @returns {Res} */
export const download = (name, type, body) => ({
  status: 200,
  headers: { 'content-type': type, 'content-disposition': disposition('attachment', name) },
  body,
});

/**
 * A stored file, byte for byte (an upload, an attachment, a PDF): saved, or shown in the browser when `inline`.
 * @param {string} name @param {string} type @param {string} base64 @returns {Res}
 */
export const bytes = (name, type, base64, inline = false) => ({
  status: 200,
  headers: { 'content-type': type, 'content-disposition': disposition(inline ? 'inline' : 'attachment', name) },
  body: Buffer.from(base64, 'base64').toString('latin1'),
  encoding: 'latin1',
});

/** @param {Req['headers']} headers @param {string} name */
export const header = (headers, name) => {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : (v ?? '');
};

/** A request cookie's value ("" when the request has none by that name). @param {Req['headers']} headers @param {string} name */
export const cookieOf = (headers, name) =>
  header(headers, 'cookie')
    .split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? '';

/**
 * The fields and files of a request body: urlencoded, JSON (an object) or multipart/form-data. The body is latin1
 * text, one character per byte, so files keep their bytes. A malformed body gives no fields rather than a throw.
 * @param {Req} req @returns {{ fields: Record<string, string[]>, files: (Upload & { field: string })[] }}
 */
export function parseBody(req) {
  /** @type {Record<string, string[]>} */
  const fields = {};
  /** @type {(Upload & { field: string })[]} */
  const files = [];
  const add = (/** @type {string} */ k, /** @type {string} */ v) => {
    fields[k] = [...(fields[k] ?? []), v];
  };
  const ctype = header(req.headers, 'content-type');
  const type = ctype.toLowerCase();
  const utf8 = (/** @type {string} */ s) => Buffer.from(s, 'latin1').toString('utf8');
  if (type.startsWith('application/json')) {
    try {
      const o = JSON.parse(utf8(req.body));
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) add(k, String(x));
      }
    } catch {
      // not JSON: no fields
    }
  } else if (type.startsWith('multipart/form-data')) {
    // the boundary is case-sensitive: read it from the header as sent
    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
    if (boundary) {
      const b = `--${boundary[1] ?? boundary[2]}`;
      for (const chunk of req.body.split(b).slice(1)) {
        if (chunk.startsWith('--')) break;
        const sep = chunk.indexOf('\r\n\r\n');
        if (sep < 0) continue;
        const head = chunk.slice(0, sep);
        const value = chunk.slice(sep + 4).replace(/\r\n$/, '');
        const name = /name="([^"]*)"/i.exec(head)?.[1];
        if (!name) continue;
        // browsers send a quote in a file name as %22
        const filename = /filename="([^"]*)"/i.exec(head)?.[1]?.replaceAll('%22', '"');
        if (filename === undefined) add(name, utf8(value));
        else if (filename) {
          const ctype = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? 'application/octet-stream';
          files.push({
            field: name,
            name: utf8(filename),
            type: ctype,
            size: value.length,
            data: Buffer.from(value, 'latin1').toString('base64'),
          });
        }
      }
    }
  } else {
    for (const [k, v] of new URLSearchParams(utf8(req.body))) add(k, v);
  }
  return { fields, files };
}

/** The first value of a field, trimmed ('' when absent). @param {Record<string, string[]>} fields @param {string} name */
export const field = (fields, name) => (fields[name]?.[0] ?? '').trim();

/**
 * Matches a path against patterns like "/m/:id/att/:i" and returns the handler and its decoded params, or null.
 * @template H
 * @param {string} method @param {string} path @param {[string, string, H][]} table [method, pattern, handler]
 * @returns {{ handler: H, params: Record<string, string> } | null}
 */
export function route(method, path, table) {
  const segs = path.split('/').filter(Boolean);
  for (const [m, pattern, handler] of table) {
    if (m !== method) continue;
    const want = pattern.split('/').filter(Boolean);
    if (want.length !== segs.length) continue;
    /** @type {Record<string, string>} */
    const params = {};
    let hit = true;
    for (let i = 0; i < want.length && hit; i++) {
      if (want[i].startsWith(':')) {
        try {
          params[want[i].slice(1)] = decodeURIComponent(segs[i]);
        } catch {
          hit = false;
        }
      } else hit = want[i] === segs[i];
    }
    if (hit) return { handler, params };
  }
  return null;
}

/**
 * One page of a list (1-based; out-of-range pages clamp), and a pager linking every page, keeping the other query
 * parameters. Long lists are paged so the agent has to look further than the first screen.
 * @template T @param {T[]} list @param {URL} url @param {number} [size]
 */
export function paginate(list, url, size = 10) {
  const pages = Math.max(1, Math.ceil(list.length / size));
  const asked = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  const p = Math.min(pages, Math.max(1, Number.isFinite(asked) ? asked : 1));
  const link = (/** @type {number} */ n) => {
    const q = new URLSearchParams(url.searchParams);
    q.set('page', String(n));
    return `${url.pathname}?${q}`;
  };
  const pager =
    pages > 1
      ? html`<p class="pager">Page ${p} of ${pages}: ${Array.from({ length: pages }, (_, i) =>
          i + 1 === p ? html`<strong>${i + 1}</strong> ` : html`<a href="${link(i + 1)}">${i + 1}</a>`,
        )}</p>`
      : '';
  return { items: list.slice((p - 1) * size, p * size), page: p, pages, pager };
}

/** A new record id, unique in the app's state: PREFIX-<n>. @param {{ seq: number }} state @param {string} prefix */
export const nextId = (state, prefix) => `${prefix}-${++state.seq}`;

/**
 * Logs what the agent did, for the grader (order, duplicates, forbidden actions). @param {{ events: any[] }} state
 * @param {string} type @param {Record<string, unknown>} data @param {number} at
 */
export function logEvent(state, type, data, at) {
  state.events.push({ at, type, ...data });
}

/** The notice a redirect carries in `?flash=`. @param {URL} url */
export const flashOf = (url) => url.searchParams.get('flash');

/** A path with a flash notice. @param {string} path @param {string} text */
export const withFlash = (path, text) => `${path}${path.includes('?') ? '&' : '?'}flash=${encodeURIComponent(text)}`;
