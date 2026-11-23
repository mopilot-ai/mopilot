// Superagent watch settings: the one repo, the allowed GitHub logins, the rules with their mode, cooldown and rate limit, and pause. Pure: reading, validating and normalizing only.
// A rule is Off, Observe or Auto. Auto is shown but not available until S2, so a stored "auto" reads back as Observe.

const KEY = 'config';
const MAX_ALLOWED = 50;
const HOUR_MS = 3_600_000;
const COOLDOWN_MS = 5 * 60_000;
const PER_HOUR = 20;
const MODES = Object.freeze(['off', 'observe']);

/** What each rule is for, as Settings says it. `available` is false for a rule whose events S1 does not watch yet. */
const RULES = Object.freeze([
  { id: 'explicit', name: 'Explicit requests', line: 'An allowed person mentions the bot. Runs in Observe and Auto.', available: true },
  { id: 'ci', name: 'Fix red checks on my PRs', line: 'A check fails on a PR from an allowed person.', available: false },
  { id: 'bugs', name: 'Reproduce new bug reports', line: 'Works silently. Speaks only with a fix.', available: true },
  { id: 'questions', name: 'Answer questions in issues', line: 'Replies in the thread with a marked automated post.', available: true },
]);

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LOGIN = /^[a-z\d](?:[a-z\d-]{0,38})$/i;

/** 'owner/name' as typed (a github.com URL is accepted), or null. @param {unknown} value */
function parseRepo(value) {
  if (typeof value !== 'string') return null;
  const t = value
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  return REPO.test(t) ? t : null;
}

/** A GitHub login without a leading @, or null. @param {unknown} value */
function parseLogin(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim().replace(/^@/, '');
  return LOGIN.test(t) ? t : null;
}

/**
 * Logins from a list: valid ones in order without duplicates (case-insensitive), and the entries that were refused.
 * @param {unknown} list
 * @returns {{ logins: string[], invalid: string[] }}
 */
function parseLogins(list) {
  const logins = [];
  const invalid = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const login = parseLogin(item);
    if (!login) invalid.push(String(item));
    else if (!seen.has(login.toLowerCase())) {
      seen.add(login.toLowerCase());
      logins.push(login);
    }
  }
  if (logins.length > MAX_ALLOWED) invalid.push(...logins.splice(MAX_ALLOWED));
  return { logins, invalid };
}

const posInt = (v, fallback) => (Number.isInteger(v) && v > 0 ? v : fallback);
const record = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** The settings as saved, made valid: anything missing, mistyped or unavailable falls back to its default. @param {unknown} raw */
function normalizeConfig(raw) {
  const r = record(raw);
  const rules = {};
  for (const def of RULES) {
    const saved = record(record(r.rules)[def.id]);
    rules[def.id] = {
      mode: saved.mode === 'off' ? 'off' : 'observe',
      cooldownMs: posInt(saved.cooldownMs, COOLDOWN_MS),
      perHour: posInt(saved.perHour, PER_HOUR),
    };
  }
  const paused = record(r.paused);
  return {
    repo: parseRepo(r.repo),
    botLogin: parseLogin(r.botLogin) ?? 'mopilot-superagent',
    allowed: parseLogins(r.allowed).logins,
    rules,
    paused: { all: paused.all === true, github: paused.github === true },
  };
}

/** The saved settings of a store, normalized. @param {{ watch: { settings: { get(key: string): unknown } } }} store */
const loadConfig = (store) => normalizeConfig(store.watch.settings.get(KEY));
/** Saves settings after normalizing them. */
function saveConfig(store, config) {
  const next = normalizeConfig(config);
  store.watch.settings.set(KEY, next);
  return next;
}

module.exports = { RULES, MODES, MAX_ALLOWED, HOUR_MS, parseRepo, parseLogin, parseLogins, normalizeConfig, loadConfig, saveConfig };
