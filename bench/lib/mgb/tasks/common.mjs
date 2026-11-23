// MoPilot 12-Grid Bench (#1381) helpers MGB tasks share: reading amounts, attachments, sent mail, issues and events
// from the fixture apps' state, and building the shop and mail fixtures that several back-office tasks start from.
import { has, norm } from '../grade.mjs';
import { dayOffset, fmtMoney, parseMoney } from '../seed.mjs';

const MONEY = /\(?-?\s?(?:USD\s?|\$|€|£)?\s?\d[\d,]*(?:\.\d{1,2})?\)?/gi;

/** Every amount written in a text, in cents ("$1,234.50", "1234.5", "USD 80"). @param {unknown} text */
export function amountsIn(text) {
  return [...String(text ?? '').matchAll(MONEY)].map((m) => parseMoney(m[0].replace(/[.,]$/, '').trim())).filter((c) => c !== null);
}
/** Whether a text names an amount, however it is written. @param {unknown} text @param {number} cents */
export const mentionsAmount = (text, cents) => amountsIn(text).includes(cents);

/** @param {string} b64 */
const head = (b64, n) =>
  Buffer.from(b64 ?? '', 'base64')
    .subarray(0, n)
    .toString('latin1');
/** An image an agent attached (a screenshot): an image type or extension, and bytes that are not empty. @param {any} a */
export const isImage = (a) =>
  !!a && (/^image\//i.test(a.type ?? '') || /\.(png|jpe?g|gif|webp|heic|tiff?)$/i.test(a.name ?? '')) && head(a.data, 4).length === 4;
/** A PDF by its bytes, whatever it is called. @param {any} a */
export const isPdf = (a) => !!a && head(a.data, 5) === '%PDF-';

/** Messages the user sent (the mail app's Sent folder). @param {any} mail */
export const sent = (mail) => (mail?.messages ?? []).filter((/** @type {any} */ m) => m.folder === 'sent');
/** Sent messages addressed (To or Cc) to an address. @param {any} mail @param {string} email */
export const sentTo = (mail, email) => sent(mail).filter((/** @type {any} */ m) => [...m.to, ...m.cc].some((x) => same(x, email)));
const same = (/** @type {unknown} */ a, /** @type {unknown} */ b) => norm(a) === norm(b);
/** The text of a message: subject and body. @param {any} m */
export const textOf = (m) => `${m?.subject ?? ''}\n${m?.body ?? ''}`;

/** Issues whose title and body mention every one of `needles`. @param {any} tracker @param {string[]} needles */
export const issuesMentioning = (tracker, needles) =>
  (tracker?.issues ?? []).filter((/** @type {any} */ i) => needles.every((n) => has(`${i.title}\n${i.body}`, n)));

/** An app's events of one type. @param {any} app @param {string} type */
export const eventsOf = (app, type) => (app?.events ?? []).filter((/** @type {any} */ e) => e.type === type);

/**
 * Changes made around the browser a task is about: events stamped `script` (curl, a shell) or `page-script` (a fetch
 * run in a page), per app. The run records them; a pass that relied on them is called out, never counted silently.
 * @param {Record<string, any>} state
 */
export function offSurface(state) {
  /** @type {{ app: string, type: string, via: string }[]} */
  const out = [];
  for (const [app, s] of Object.entries(state ?? {})) {
    for (const e of s?.events ?? []) if (e.via && e.via !== 'browser') out.push({ app, type: e.type, via: e.via });
  }
  return out;
}

/** A shop order's total in cents: items plus shipping. @param {{ items: { qty: number, priceCents: number }[], shippingCents?: number }} o */
export const orderTotal = (o) => o.items.reduce((t, i) => t + i.qty * i.priceCents, 0) + (o.shippingCents ?? 0);

/** A plain-text invoice body for an order, as a supplier would send it. @param {{ number: string, order: string, lines: { name: string, qty: number, priceCents: number }[], shippingCents: number, totalCents: number, footer?: string }} inv */
export function invoiceText(inv) {
  return [
    `Invoice ${inv.number}`,
    `Your order: ${inv.order}`,
    '',
    ...inv.lines.map((l) => `${l.qty} x ${l.name} @ ${fmtMoney(l.priceCents)} = ${fmtMoney(l.qty * l.priceCents)}`),
    `Shipping: ${fmtMoney(inv.shippingCents)}`,
    `Amount due: ${fmtMoney(inv.totalCents)}`,
    ...(inv.footer ? ['', inv.footer] : []),
  ].join('\n');
}

/** An ISO time on a day, at a seeded hour. @param {string} day YYYY-MM-DD @param {number} hour */
export const at = (day, hour) => `${day}T${String(hour).padStart(2, '0')}:${String((hour * 7) % 60).padStart(2, '0')}:00Z`;

/** A company name as a fictional mail domain label: "Granite Works" → "graniteworks". @param {string} name */
export const slug = (name) => name.toLowerCase().replace(/[^a-z]+/g, '');

/** Whether a text names an id as a whole token, any case: "RF-2" is not in "RF-21", "SKU-12" not in "XSKU-12". @param {unknown} text @param {string} id */
export const mentionsId = (text, id) =>
  new RegExp(`(?<![A-Za-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i').test(String(text));

// a whole number on its own: not part of an id (SKU-12, AB3K), a date (2026-10-12), an amount ($1,234.50) or a decimal
const WHOLE = /(?<![\w$€£-]|\d[.,])\d+(?![\w-]|[.,]\d)/g;
/** The whole numbers written on their own in a text. @param {unknown} text */
export const wholeNumbers = (text) => [...String(text).matchAll(WHOLE)].map((m) => Number(m[0]));
/** Whether one line of a text mentions `needle` and the whole number `n` ("SKU-104 x 12", "Orders placed: 9"). @param {unknown} text @param {string} needle @param {number} n */
export const lineWithNumber = (text, needle, n) =>
  String(text)
    .split('\n')
    .some((line) => has(line, needle) && wholeNumbers(line).includes(n));

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/**
 * Whether a text names a day, however a person writes it: 2026-10-14, October 14, Oct 14, 14 October, 14 Oct or
 * 10/14/2026. @param {unknown} text @param {string} day YYYY-MM-DD
 */
export function mentionsDay(text, day) {
  const [y, m, d] = day.split('-').map(Number);
  const [long, short] = [MONTHS[m - 1], MONTHS[m - 1].slice(0, 3)];
  const forms = [day, `${long} ${d}`, `${short} ${d}`, `${d} ${long}`, `${d} ${short}`, `${m}/${d}/${y}`];
  return forms.some((f) => new RegExp(`(?<![\\w/])${f}(?![\\d/])`, 'i').test(String(text)));
}

/** "October 14, 2026": a day as a person writes it. @param {string} day YYYY-MM-DD */
export const longDay = (day) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });

/** The Monday of a day's week (weeks start on Monday). @param {string} day YYYY-MM-DD */
export const mondayOf = (day) => dayOffset(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));

/** The ISO week number of a day: the week of its Thursday, counted from the year's first Thursday. @param {string} day YYYY-MM-DD */
export function isoWeek(day) {
  const thursday = dayOffset(mondayOf(day), 3);
  const daysIn = (Date.parse(`${thursday}T00:00:00Z`) - Date.parse(`${thursday.slice(0, 4)}-01-01T00:00:00Z`)) / 86400000;
  return Math.floor(daysIn / 7) + 1;
}
