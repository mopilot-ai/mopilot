// Reads a passwords file another browser exported as CSV (Safari's File → Export → Passwords: Title, URL, Username, Password, Notes, OTPAuth; Chrome's name, url, username, password, note have the same columns by other names): one login per web origin and user name.
const { fs } = require('../../../platform/ports/fs.cjs');
const { ImportError, classify } = require('./errors.cjs');
const { loginOrigin } = require('./chromium.cjs');

/** A passwords export bigger than this is not one. */
const MAX_BYTES = 20 * 1024 * 1024;

/** RFC 4180 rows: quoted fields may hold commas, doubled quotes and line breaks. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** The column holding one of `names` (case-insensitive), or -1. */
const column = (header, names) => header.findIndex((h) => names.includes(h.trim().toLowerCase()));

/**
 * The logins in an exported passwords file: { logins: [{ origin, username, password }], stats }. Rows without a web
 * address or a password are left out and counted; for one origin and user name the last row wins.
 * @param {string} file
 * @param {{ fs?: typeof import('node:fs') }} [o]
 */
async function readPasswordsCsv(file, o = {}) {
  const f = o.fs ?? fs;
  let text;
  try {
    const st = await f.promises.lstat(file);
    if (!st.isFile()) throw new ImportError('unsupported', 'The chosen passwords file is not a regular file.');
    if (st.size > MAX_BYTES) throw new ImportError('too_large', 'The passwords file is too large.');
    text = await f.promises.readFile(file, 'utf8');
  } catch (error) {
    throw classify(error);
  }
  const [header = [], ...rows] = parseCsv(text);
  const at = {
    url: column(header, ['url', 'website', 'login_uri', 'origin']),
    username: column(header, ['username', 'login', 'login_username', 'user name']),
    password: column(header, ['password', 'login_password']),
  };
  if (at.url < 0 || at.password < 0) throw new ImportError('unsupported', 'The file is not a passwords export.');
  const stats = { total: 0, imported: 0, invalid: 0 };
  /** @type {Map<string, { origin: string, username: string, password: string }>} */
  const by = new Map();
  for (const r of rows) {
    // a blank line at the end of the file is not a login
    if (r.length === 1 && r[0] === '') continue;
    stats.total++;
    const url = String(r[at.url] ?? '').trim();
    // some exports list a bare host ("github.com"): a web login, over https
    const origin = loginOrigin(url && !/^[a-z][a-z0-9+.-]*:/i.test(url) ? `https://${url}` : url, null);
    const password = r[at.password] ?? '';
    if (!origin || !password) {
      stats.invalid++;
      continue;
    }
    const username = at.username < 0 ? '' : (r[at.username] ?? '');
    by.set(`${origin}\u0000${username}`, { origin, username, password });
  }
  const logins = [...by.values()];
  stats.imported = logins.length;
  return { logins, stats };
}

module.exports = { parseCsv, readPasswordsCsv, MAX_BYTES };
