// MoPilot 12-Grid Bench (#1381) seeded data: a deterministic random stream per run seed and task, fictional people,
// companies and products, money and date helpers, and canary tokens. Nothing here is real user data.

/** FNV-1a: a 32-bit hash of a string, the seed of a stream. @param {string} s */
export function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const FIRST = [
  'Ada',
  'Bram',
  'Cleo',
  'Dario',
  'Elif',
  'Farah',
  'Gus',
  'Hana',
  'Ivo',
  'Jun',
  'Kenji',
  'Lena',
  'Mateo',
  'Nia',
  'Omar',
  'Priya',
  'Quinn',
  'Rosa',
  'Sven',
  'Tariq',
  'Uma',
  'Vera',
  'Wen',
  'Ximena',
  'Yusuf',
  'Zora',
];
const LAST = [
  'Abara',
  'Bergstrom',
  'Castellan',
  'Dimitrov',
  'Eklund',
  'Ferreira',
  'Galloway',
  'Haddad',
  'Ishikawa',
  'Jovanovic',
  'Kowalczyk',
  'Lindqvist',
  'Moreau',
  'Nakamura',
  'Okafor',
  'Petrakis',
  'Quist',
  'Rinaldi',
  'Sato',
  'Tremblay',
  'Ulloa',
  'Varga',
  'Whitlock',
  'Yilmaz',
  'Zeller',
];
const CO_A = [
  'Northwind',
  'Bluefin',
  'Copperleaf',
  'Driftwood',
  'Emberline',
  'Foxglove',
  'Granite',
  'Harbor',
  'Ironbark',
  'Juniper',
  'Keystone',
  'Lumen',
];
const CO_B = ['Supply', 'Traders', 'Logistics', 'Works', 'Partners', 'Goods', 'Labs', 'Outfitters', 'Wholesale', 'Freight'];
const PRODUCT_A = ['Brass', 'Walnut', 'Linen', 'Ceramic', 'Steel', 'Cork', 'Oak', 'Glass', 'Wool', 'Bamboo', 'Copper', 'Slate'];
const PRODUCT_B = [
  'desk lamp',
  'side table',
  'throw blanket',
  'pour-over kettle',
  'bookend set',
  'wall clock',
  'planter',
  'cutting board',
  'floor mat',
  'serving tray',
];
const CITIES = ['Lisbon', 'Osaka', 'Tallinn', 'Valparaiso', 'Ghent', 'Halifax', 'Bergen', 'Cork', 'Aarhus', 'Porto', 'Kyoto', 'Leeds'];
// no 0/O, 1/I/L: a token read off a screen is never ambiguous
const TOKEN_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * A deterministic random stream (mulberry32) with the helpers tasks draw their data from. `fork(label)` gives an
 * independent stream, so adding a draw in one part of a task never shifts the data of another.
 * @param {string} seed
 */
export function rng(seed) {
  let a = hash32(seed);
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** A whole number from lo to hi, both included. @param {number} lo @param {number} hi */
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  /** @template T @param {readonly T[]} list @returns {T} */
  const pick = (list) => {
    if (!list.length) throw new Error('pick from an empty list');
    return list[int(0, list.length - 1)];
  };
  /** @template T @param {readonly T[]} list @returns {T[]} */
  const shuffle = (list) => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  /** k distinct items. @template T @param {readonly T[]} list @param {number} k @returns {T[]} */
  const sample = (list, k) => {
    if (k > list.length) throw new Error(`sample ${k} from ${list.length}`);
    return shuffle(list).slice(0, k);
  };
  /** @param {string} prefix @param {number} [n] */
  const token = (prefix, n = 6) => `${prefix}-${Array.from({ length: n }, () => TOKEN_CHARS[int(0, TOKEN_CHARS.length - 1)]).join('')}`;
  return {
    seed,
    next,
    int,
    pick,
    shuffle,
    sample,
    /** @param {number} p */
    chance: (p) => next() < p,
    /** An amount in cents from lo to hi cents. @param {number} lo @param {number} hi */
    cents: (lo, hi) => int(lo, hi),
    token,
    /** A canary: a value only the work itself can surface (seeded here, or made by a fixture app at run time). */
    canary: () => token('CNY', 8),
    person: () => {
      const first = pick(FIRST);
      const last = pick(LAST);
      return { first, last, name: `${first} ${last}` };
    },
    company: () => `${pick(CO_A)} ${pick(CO_B)}`,
    product: () => `${pick(PRODUCT_A)} ${pick(PRODUCT_B)}`,
    city: () => pick(CITIES),
    /** @param {string} label */
    fork: (label) => rng(`${seed}/${label}`),
  };
}

/** @typedef {ReturnType<typeof rng>} Rng */

/** The stream of one task in one run: the same run seed and task always give the same data. @param {string} runSeed @param {string} taskId */
export const taskRng = (runSeed, taskId) => rng(`${runSeed}::${taskId}`);

/**
 * Distinct people (no two share a full name), each with an address at `domain`.
 * @param {Rng} r @param {number} n @param {string} domain
 */
export function people(r, n, domain) {
  if (n > FIRST.length * LAST.length) throw new Error(`too many people: ${n}`);
  const out = [];
  const seen = new Set();
  while (out.length < n) {
    const p = r.person();
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    out.push({ ...p, email: `${p.first}.${p.last}@${domain}`.toLowerCase() });
  }
  return out;
}

/** Distinct values from a generator (companies, products). @param {() => string} gen @param {number} n */
export function distinct(gen, n, maxTries = 1000) {
  const out = new Set();
  for (let i = 0; out.size < n; i++) {
    if (i >= maxTries) throw new Error(`only ${out.size} distinct values of ${n}`);
    out.add(gen());
  }
  return [...out];
}

/** "$1,234.50" from cents. @param {number} cents */
export function fmtMoney(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}$${whole}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Cents from an amount as a person or an agent writes it: "$1,234.50", "1234.5", "USD 80", "-$12" and "(12.00)" (both
 * negative). Null for anything else, including a decimal comma ("1.234,50") and a doubled sign ("(-5)").
 * @param {unknown} text
 */
export function parseMoney(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? Math.round(text * 100) : null;
  if (typeof text !== 'string') return null;
  let s = text
    .trim()
    .replace(/\b(?:usd|eur|gbp)\b/gi, '')
    .trim();
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('-')) {
    // "(-5)" is ambiguous: refused rather than read as +5
    if (neg) return null;
    neg = true;
    s = s.slice(1).trim();
  }
  s = s.replace(/^[$€£]\s*/, '');
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(Number(s.replaceAll(',', '')) * 100);
  return neg ? -cents : cents;
}

/**
 * A day relative to the run's "today", as YYYY-MM-DD (calendar tasks are relative, so a run on any date works).
 * @param {string} today YYYY-MM-DD @param {number} days
 */
export function dayOffset(today, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`not a YYYY-MM-DD date: ${today}`);
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The first Monday after a day (next week's plan starts there; a Monday gives the one a week later). @param {string} day YYYY-MM-DD */
export function nextMonday(day) {
  const dow = new Date(`${dayOffset(day, 0)}T12:00:00Z`).getUTCDay();
  return dayOffset(day, (8 - dow) % 7 || 7);
}
