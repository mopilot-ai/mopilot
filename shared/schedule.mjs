// The scheduler's pure rules, shared by main (electron/platform/scheduler.cjs) and the Scheduled page.

/** A persisted millisecond timestamp must fit a JavaScript Date; invalid inputs use the caller's safe fallback. */
export function scheduleTime(value, fallback = 0) {
  if (value !== null && typeof value !== 'number' && typeof value !== 'string') return fallback;
  if (typeof value === 'string' && !value.trim()) return fallback;
  const time = Number(value);
  return Number.isSafeInteger(time) && Math.abs(time) <= 8_640_000_000_000_000 ? time : fallback;
}

const DAY = 86_400_000;
/** The lattice every rule without its own DTSTART is counted from: 2020-01-01 00:00 wall clock (fake UTC). */
const BASE = Date.UTC(2020, 0, 1);
/** A Monday before BASE, for weekly rules (RRULE weeks start on Monday). */
const BASE_WEEK = Date.UTC(2019, 11, 30);

/**
 * How many days back to start counting a rule's occurrences. rrule walks every occurrence from dtstart, so a
 * minutely rule anchored 400 days back walks ~576k of them: about a second of frozen UI per call, and the
 * Scheduled list calls it on every render. Sub-daily rules (period in ms) get a short window; the rest keep 400.
 */
export function anchorDays(periodMs, interval) {
  if (!periodMs) return 400;
  return Math.min(400, Math.ceil((periodMs * interval * 2) / 86400000) + (periodMs >= 3_600_000 ? 7 : 1));
}

/** An unanswered approval in an unattended scheduled run turns into "needs attention" after this long. */
export const ATTENTION_MS = 60 * 60_000;

/** How far back a missed run is still caught up when MoPilot opens or the computer wakes (Claude Desktop's rule). */
export const CATCH_UP_MS = 7 * DAY;

// rrule counts in UTC; a rule's BYHOUR means the user's clock (as the Codex app reads it). So rules run on a
// "wall clock": a time whose UTC fields are the local ones.
const toWall = (ms) => {
  const d = new Date(ms);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
};
const fromWall = (w) => {
  const d = new Date(w);
  return new Date(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  ).getTime();
};

/** How far a time zone's clock is ahead of UTC at `ms` (whole seconds), read from Intl: the Host evaluates a task on the clock of the Mac that made it. @param {number} ms @param {string} zone */
function offsetIn(ms, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(ms));
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
/** The wall clock of `zone` (this process's own without one). @param {number} ms @param {string} [zone] */
const toWallIn = (ms, zone) => (zone ? ms + offsetIn(ms, zone) : toWall(ms));
/** A wall time back to real time; the second step settles a time near a daylight-saving change. @param {number} w @param {string} [zone] */
const fromWallIn = (w, zone) => (zone ? w - offsetIn(w - offsetIn(w, zone), zone) : fromWall(w));

/** Whether `zone` is an IANA time zone this runtime knows. @param {unknown} zone */
export function isTimeZone(zone) {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The rule helpers, given rrule's RRule class (main requires it, the page imports it).
 * Every occurrence sits on a fixed lattice, so the same rule names the same times on every call and in
 * every process: the run ledger keys a run by its time.
 */
export function scheduleRules(RRule) {
  const PERIOD = { [RRule.SECONDLY]: 1000, [RRule.MINUTELY]: 60_000, [RRule.HOURLY]: 3_600_000 };
  /** The first lattice point at or before `wall - lookback`, as dtstart. */
  function anchor(o, wall) {
    const interval = o.interval ?? 1;
    const sub = PERIOD[o.freq];
    if (sub) {
      const step = sub * interval;
      const from = wall - DAY * anchorDays(sub, interval);
      return BASE + Math.floor((from - BASE) / step) * step;
    }
    if (o.freq === RRule.DAILY || o.freq === RRule.WEEKLY) {
      const base = o.freq === RRule.WEEKLY ? BASE_WEEK : BASE;
      const step = (o.freq === RRule.WEEKLY ? 7 : 1) * DAY * interval;
      const from = wall - Math.max(400 * DAY, 2 * step);
      return base + Math.floor((from - base) / step) * step;
    }
    // monthly and yearly: count whole periods of months from January 2020
    const months = (o.freq === RRule.YEARLY ? 12 : 1) * interval;
    const d = new Date(wall - Math.max(400 * DAY, 2 * months * 31 * DAY));
    const since = (d.getUTCFullYear() - 2020) * 12 + d.getUTCMonth();
    return Date.UTC(2020, Math.floor(since / months) * months, 1);
  }
  /** Build the rule around a time: {r, wall, zone}, where `wall` says its times are on the user's clock (`zone`'s, or this process's). */
  function build(rule, at, zone) {
    const o = RRule.parseString(rule.startsWith('RRULE:') ? rule.slice(6) : rule);
    if (o.freq === undefined) return null;
    // a rule with its own DTSTART keeps it, in real time
    if (o.dtstart) return { r: new RRule(o), wall: false, zone };
    return { r: new RRule({ ...o, dtstart: new Date(anchor(o, toWallIn(at, zone))) }), wall: true, zone };
  }
  const to = (b, ms) => (b.wall ? toWallIn(ms, b.zone) : ms);
  const from = (b, d) => (d ? (b.wall ? fromWallIn(d.getTime(), b.zone) : d.getTime()) : null);

  return {
    /**
     * The rule as a sentence ("Every weekday at 9", "Every day at 10:30"), or the rule itself when it doesn't parse.
     * rrule's own text names the hours only (10:30 reads "at 10") and drops them from a monthly rule, so the times are
     * said here, from its hours and minutes.
     */
    describe(rule) {
      try {
        const o = RRule.parseString(rule.startsWith('RRULE:') ? rule.slice(6) : rule);
        const hours = [o.byhour ?? []].flat().sort((a, b) => a - b);
        const minutes = [o.byminute ?? 0].flat().sort((a, b) => a - b);
        let text = new RRule(hours.length ? { ...o, byhour: null, byminute: null, bysecond: null } : o).toText();
        if (hours.length) {
          const times = hours.flatMap((h) => minutes.map((m) => (m ? `${h}:${String(m).padStart(2, '0')}` : `${h}`)));
          text += ` at ${times.length > 1 ? `${times.slice(0, -1).join(', ')} and ${times.at(-1)}` : times[0]}`;
        }
        return text.charAt(0).toUpperCase() + text.slice(1);
      } catch {
        return rule;
      }
    },
    /** The rule's next time after `after`, or null (no more, or a rule that doesn't parse); on `zone`'s clock when given. */
    nextRun(rule, after = new Date(), zone = undefined) {
      try {
        const b = build(rule, after.getTime(), zone);
        if (!b) return null;
        const t = from(b, b.r.after(new Date(to(b, after.getTime()))));
        return t === null ? null : new Date(t);
      } catch {
        return null;
      }
    },
    /** The rule's latest time at or before `at` (ms), or null; on `zone`'s clock when given. */
    lastRun(rule, at, zone = undefined) {
      try {
        const b = build(rule, at, zone);
        if (!b) return null;
        return from(b, b.r.before(new Date(to(b, at)), true));
      } catch {
        return null;
      }
    },
  };
}

const CRON_DAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const RRULE_DAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** A rule's parts, as KEY -> value. */
function partsOf(rule) {
  const out = {};
  for (const p of (rule.startsWith('RRULE:') ? rule.slice(6) : rule).split(';')) {
    const [k, v] = p.split('=');
    if (k && v !== undefined) out[k.toUpperCase()] = v;
  }
  return out;
}

const listOf = (v) => String(v).split(',');
const isInt = (v, lo, hi) => /^\d+$/.test(v) && Number(v) >= lo && Number(v) <= hi;

/**
 * The 5-field cron expression (local time) for a rule, as Claude Desktop's scheduled tasks take it, or null when
 * cron can't say it the same way (an interval that doesn't divide the hour or day, a DTSTART, counts, ...).
 */
export function toCron(rule) {
  const p = partsOf(rule);
  const known = new Set(['FREQ', 'INTERVAL', 'BYHOUR', 'BYMINUTE', 'BYDAY']);
  if (Object.keys(p).some((k) => !known.has(k))) return null;
  const interval = p.INTERVAL === undefined ? 1 : Number(p.INTERVAL);
  if (!Number.isInteger(interval) || interval < 1) return null;
  const minutes = p.BYMINUTE ?? '0';
  if (!listOf(minutes).every((m) => isInt(m, 0, 59))) return null;
  const hours = p.BYHOUR;
  if (hours !== undefined && !listOf(hours).every((h) => isInt(h, 0, 23))) return null;
  let dow = '*';
  if (p.BYDAY !== undefined) {
    const days = listOf(p.BYDAY);
    if (!days.every((d) => Object.hasOwn(CRON_DAY, d))) return null;
    dow = days.map((d) => CRON_DAY[d]).join(',');
  }
  switch (p.FREQ) {
    case 'MINUTELY':
      if (60 % interval || hours !== undefined || p.BYMINUTE !== undefined) return null;
      return `${interval === 1 ? '*' : `*/${interval}`} * * * ${dow}`;
    case 'HOURLY':
      if (24 % interval || hours !== undefined) return null;
      return `${minutes} ${interval === 1 ? '*' : `*/${interval}`} * * ${dow}`;
    case 'DAILY':
    case 'WEEKLY':
      if (interval !== 1 || hours === undefined) return null;
      if (p.FREQ === 'WEEKLY' && dow === '*') return null;
      return `${minutes} ${hours} * * ${dow}`;
    default:
      return null;
  }
}

/** One cron field as a list of numbers, or null when it is a form this reader doesn't take. */
function cronList(field, lo, hi) {
  const out = [];
  for (const part of field.split(',')) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      if (a > b || a < lo || b > hi) return null;
      for (let i = a; i <= b; i++) out.push(i);
    } else if (isInt(part, lo, hi)) out.push(Number(part));
    else return null;
  }
  return out;
}

/** The RRULE for a 5-field cron expression (Claude Desktop's), or null when it has no RRULE this app runs. */
export function fromCron(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dowField] = f;
  if (dom !== '*' || mon !== '*') return null;
  let byday = '';
  if (dowField !== '*') {
    const days = cronList(dowField, 0, 7);
    if (!days) return null;
    byday = `;BYDAY=${[...new Set(days.map((d) => RRULE_DAY[d % 7]))].join(',')}`;
  }
  const every = (field) => (field === '*' ? 1 : /^\*\/(\d+)$/.exec(field) ? Number(field.slice(2)) : 0);
  if (hour === '*' && every(min)) return 60 % every(min) ? null : `FREQ=MINUTELY;INTERVAL=${every(min)}${byday}`;
  const minutes = cronList(min, 0, 59);
  if (!minutes) return null;
  if (every(hour)) return 24 % every(hour) ? null : `FREQ=HOURLY;INTERVAL=${every(hour)};BYMINUTE=${minutes.join(',')}${byday}`;
  const hours = cronList(hour, 0, 23);
  if (!hours) return null;
  return `FREQ=${byday ? 'WEEKLY' : 'DAILY'};BYHOUR=${hours.join(',')};BYMINUTE=${minutes.join(',')}${byday}`;
}
