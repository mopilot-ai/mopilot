// MoPilot 12-Grid Bench (#1381) helpers the record apps (crm, tracker) share: fixture lists and ids that never collide,
// labelled form controls that keep what was typed, search and list markup, date checks and change tracking.
import { html, nextId } from './kit.mjs';

export const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** A fixture's list of records (objects); throws a clear error otherwise. @param {any} f @param {string} key @param {string} app */
export function records(f, key, app) {
  const list = f?.[key];
  if (!Array.isArray(list) || !list.every((x) => x && typeof x === 'object'))
    throw new Error(`${app} fixture needs a ${key} list of objects`);
  return /** @type {any[]} */ (list);
}

/** A new id PREFIX-<n> that `taken` does not hold yet. @param {{ seq: number }} state @param {string} prefix @param {(id: string) => boolean} taken */
export function freshId(state, prefix, taken) {
  let id;
  do id = nextId(state, prefix);
  while (taken(id));
  return id;
}

/**
 * The ids of a fixture's records: the given ones kept (duplicates refused), the others PREFIX-<n> avoiding them.
 * @param {{ seq: number }} state @param {string} prefix @param {any[]} list @param {string} prop
 */
export function assignIds(state, prefix, list, prop) {
  const given = list.filter((x) => x[prop] != null).map((x) => String(x[prop]));
  const taken = new Set(given);
  if (taken.size < given.length) throw new Error(`duplicate ${prop} in the fixture: ${given.find((g, i) => given.indexOf(g) !== i)}`);
  return list.map((x) => {
    if (x[prop] != null) return String(x[prop]);
    const id = freshId(state, prefix, (i) => taken.has(i));
    taken.add(id);
    return id;
  });
}

/** A real calendar day written YYYY-MM-DD. @param {unknown} s */
export function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

/**
 * Copies `next[k]` into `rec` for each key whose value differs; returns what changed, `{ key: { from, to } }`.
 * @param {Record<string, any>} rec @param {Record<string, any>} next @param {string[]} keys
 */
export function applyChanges(rec, next, keys) {
  /** @type {Record<string, { from: unknown, to: unknown }>} */
  const changes = {};
  for (const k of keys) {
    if (JSON.stringify(rec[k]) === JSON.stringify(next[k])) continue;
    changes[k] = { from: rec[k], to: next[k] };
    rec[k] = next[k];
  }
  return changes;
}

/** A labelled input. @param {string} label @param {string} name @param {string} value */
export const input = (label, name, value, type = 'text') =>
  html`<label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" value="${value}">`;

/** A labelled textarea. @param {string} label @param {string} name @param {string} value */
export const textarea = (label, name, value) =>
  html`<label for="${name}">${label}</label><textarea id="${name}" name="${name}">${value}</textarea>`;

/**
 * A labelled select; options are values or [value, text] pairs. @param {string} label @param {string} name
 * @param {(string | [string, string])[]} options @param {string} selected
 */
export const select = (label, name, options, selected) =>
  html`<label for="${name}">${label}</label><select id="${name}" name="${name}">${options.map((o) => {
    const [v, t] = Array.isArray(o) ? o : [o, o];
    return html`<option value="${v}"${v === selected ? ' selected' : ''}>${t}</option>`;
  })}</select>`;

/** A group of labelled checkboxes. @param {string} legend @param {string} name @param {string[]} options @param {string[]} checked */
export const checkboxes = (legend, name, options, checked) =>
  html`<fieldset><legend>${legend}</legend>${options.map(
    (o) => html`<label><input type="checkbox" name="${name}" value="${o}"${checked.includes(o) ? ' checked' : ''}> ${o}</label>`,
  )}</fieldset>`;

/** A query parameter, trimmed. @param {URL} url @param {string} name */
export const param = (url, name) => (url.searchParams.get(name) ?? '').trim();

/** Whether any of `values` contains the search text (case-insensitive; an empty search matches). @param {string} q @param {unknown[]} values */
export const matches = (q, values) => !q || values.some((v) => String(v).toLowerCase().includes(q.toLowerCase()));

/** A GET search form, with extra filter controls before the button. @param {string} q @param {string} label @param {unknown} [extra] */
export const searchForm = (q, label, extra = '') =>
  html`<form method="get"><input type="search" name="q" value="${q}" aria-label="${label}" placeholder="${label}"> ${extra} <button>Search</button></form>`;

/** "3 deals", "1 deal". @param {number} n @param {string} noun */
export const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** A table's rows, or one "Nothing here." row. @param {unknown[]} rows @param {number} cols */
export const rowsOr = (rows, cols) => (rows.length ? rows : html`<tr><td colspan="${cols}">Nothing here.</td></tr>`);
