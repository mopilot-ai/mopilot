// The owner's rules for a Host (plan U2): the document's schema and parser, the stricter-wins merge with a managed layer, and the generation hash. Shared by the app and the Host so the two cannot read it differently.
import { sha256Hex } from '../remote/sha256.mjs';
import { CLOUD_BLOCK } from './cloudPolicy.mjs';
import { SPEND_BLOCK } from './spend.mjs';

/** Declared by a Host that keeps an owner policy; an app without it is never sent one. */
export const POLICY_FEATURE = 'policy';
export const POLICY_VERSION = 1;
/** Permission modes from least to most trusting; a ceiling admits itself and everything below it. */
/** The mode a chat is in while its agent only plans (Codex's `plan` collaboration mode); a Host says an agent takes it with `planMode` on that agent's status row. */
export const PLAN_MODE = 'plan';
export const PERMISSION_ORDER = Object.freeze(['read-only', 'default', 'auto-review', 'full-access']);
/** The most trusting mode a phone may set, whatever the ceiling (the app's old `permissionCap` rule, now enforced on the Host). */
export const PHONE_PERMISSION_MAX = 'auto-review';
export const PAUSE_MINUTES = Object.freeze({ min: 5, max: 720 });
export const REMIND_MINUTES = Object.freeze({ min: 1, max: 720 });
export const NOTIFY_DETAIL = Object.freeze(['minimal', 'tool', 'full']);

/** What applies when no owner document exists or a key is missing. */
export const DEFAULT_POLICY = Object.freeze({
  version: POLICY_VERSION,
  permissionMax: 'full-access',
  approvals: Object.freeze({ remindMinutes: 10, pauseMinutes: 30 }),
  notify: Object.freeze({
    needsYou: true,
    done: false,
    paused: true,
    detail: 'tool',
    quiet: null,
  }),
});

/** Plan reads and plans only, so it stands where read-only does: a ceiling that admits read-only admits Plan, and no ceiling is named after it. */
const rank = (/** @type {string} */ mode) => PERMISSION_ORDER.indexOf(mode === PLAN_MODE ? 'read-only' : mode);
/** The less trusting of two modes. */
export const stricterMode = (/** @type {string} */ a, /** @type {string} */ b) => (rank(a) <= rank(b) ? a : b);
/** Whether `mode` is within the ceiling. */
export const withinCeiling = (/** @type {string} */ mode, /** @type {string} */ max) => rank(mode) >= 0 && rank(mode) <= rank(max);
/**
 * A chat's config under the ceiling: the mode its tools run under (its own, or the one Plan was entered from) is no more than the ceiling allows, whenever it was set and whatever the ceiling was then. Plan itself stays Plan (it reads and plans).
 * @param {Record<string, any> | null | undefined} config @param {string | undefined} max
 */
export function clampToCeiling(config, max) {
  if (!max || PERMISSION_ORDER.indexOf(max) < 0) return config ?? null;
  const above = (/** @type {unknown} */ mode) =>
    typeof mode === 'string' && mode !== PLAN_MODE && PERMISSION_ORDER.indexOf(mode) > PERMISSION_ORDER.indexOf(max);
  const under = (/** @type {unknown} */ mode) => (above(mode) ? max : mode);
  // a chat with no mode of its own runs under the families' default one: that is clamped too, when it is above the ceiling
  const fallsToDefault = above('default');
  const own = config ?? {};
  const permission = own.permission == null && fallsToDefault ? max : under(own.permission);
  // Plan entered from no mode runs under the default one: that is clamped as well, and only when it is above the ceiling
  const base = own.permission === PLAN_MODE && own.planBasePermission == null ? under('default') : under(own.planBasePermission);
  const unchanged =
    permission === own.permission &&
    (own.planBasePermission == null ? base === 'default' || base == null : base === own.planBasePermission);
  if (!config && permission == null) return null;
  return unchanged ? config : { ...own, permission, ...(base == null ? {} : { planBasePermission: base }) };
}

/** The mode a caller of this kind may set at most, given the effective ceiling. */
export const ceilingFor = (/** @type {string} */ max, /** @type {string} */ kind) =>
  kind === 'phone' ? stricterMode(max, PHONE_PERMISSION_MAX) : max;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const isObj = (/** @type {unknown} */ v) => !!v && typeof v === 'object' && !Array.isArray(v);
const intIn = (/** @type {unknown} */ v, /** @type {{min:number,max:number}} */ r) =>
  Number.isSafeInteger(v) && /** @type {number} */ (v) >= r.min && /** @type {number} */ (v) <= r.max;
const zoneOk = (/** @type {unknown} */ tz) => {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/**
 * Blocks beyond the core ones (`spend`, `cloud`): each is `{ name, parse(raw, bad), merge?(owner, managed) }`. A block reads its own key only; its parse
 * returns the clean value or throws `bad(...)`. A missing block is left out of the document.
 * @type {Array<{ name: string, parse: (raw: any, bad: (m: string) => Error) => any, merge?: (owner: any, managed: any) => any }>}
 */
const EXTRA_BLOCKS = [SPEND_BLOCK, CLOUD_BLOCK];
/** Another lane's block joins here, from its own file. */
export const addPolicyBlock = (/** @type {(typeof EXTRA_BLOCKS)[number]} */ block) => {
  if (!EXTRA_BLOCKS.some((b) => b.name === block.name)) EXTRA_BLOCKS.push(block);
};

/**
 * An owner document, checked whole: unknown keys are dropped, missing keys take their defaults, an invalid value refuses the document.
 * @param {unknown} doc @param {(m: string) => Error} bad
 */
export function parseOwnerPolicy(doc, bad) {
  if (!isObj(doc)) throw bad('That is not a policy.');
  const d = /** @type {any} */ (doc);
  if (d.version !== POLICY_VERSION) throw bad('This policy is a version this Host cannot read.');
  const out = /** @type {any} */ ({
    version: POLICY_VERSION,
    permissionMax: DEFAULT_POLICY.permissionMax,
  });
  if (d.permissionMax !== undefined) {
    if (!PERMISSION_ORDER.includes(d.permissionMax)) throw bad('Pick a permission ceiling from the list.');
    out.permissionMax = d.permissionMax;
  }
  const ap = d.approvals === undefined ? {} : d.approvals;
  if (!isObj(ap)) throw bad('Approval settings must be an object.');
  const remind = ap.remindMinutes ?? DEFAULT_POLICY.approvals.remindMinutes;
  const pause = ap.pauseMinutes ?? DEFAULT_POLICY.approvals.pauseMinutes;
  if (!intIn(remind, REMIND_MINUTES)) throw bad(`Remind after ${REMIND_MINUTES.min} to ${REMIND_MINUTES.max} minutes.`);
  if (!intIn(pause, PAUSE_MINUTES)) throw bad(`Pause after ${PAUSE_MINUTES.min} to ${PAUSE_MINUTES.max} minutes.`);
  out.approvals = { remindMinutes: remind, pauseMinutes: pause };
  const nt = d.notify === undefined ? {} : d.notify;
  if (!isObj(nt)) throw bad('Notification settings must be an object.');
  /** @type {{ needsYou: boolean, done: boolean, paused: boolean, detail: string, quiet: null | { start: string, end: string, tz: string } }} */
  const notify = { ...DEFAULT_POLICY.notify };
  for (const k of /** @type {const} */ (['needsYou', 'done', 'paused'])) {
    if (nt[k] === undefined) continue;
    if (typeof nt[k] !== 'boolean') throw bad('Notification switches are on or off.');
    notify[k] = nt[k];
  }
  if (nt.detail !== undefined) {
    if (!NOTIFY_DETAIL.includes(nt.detail)) throw bad('Pick how much a notification says.');
    notify.detail = nt.detail;
  }
  if (nt.quiet !== undefined && nt.quiet !== null) {
    const q = nt.quiet;
    if (!isObj(q) || !TIME.test(q.start) || !TIME.test(q.end) || !zoneOk(q.tz))
      throw bad('Quiet hours need a start, an end and a time zone.');
    notify.quiet = { start: q.start, end: q.end, tz: q.tz };
  }
  out.notify = notify;
  for (const b of EXTRA_BLOCKS) if (d[b.name] !== undefined) out[b.name] = b.parse(d[b.name], bad);
  return out;
}

/**
 * The effective policy: per key the stricter of the owner's and the managed layer's (#2685's rule: ceilings take the minimum, deny lists the union,
 * allow lists the intersection). With no managed layer the owner's document stands. Only a key the managed layer sets is merged.
 * @param {any} owner a parsed owner document @param {any} [managed] a parsed managed document, or null/undefined for a person
 * @returns {{ doc: any, locked: string[] }} `locked` names the keys the managed layer decides, so a client can disable the control and say why
 */
export function mergePolicy(owner, managed) {
  if (!managed) return { doc: owner, locked: [] };
  const doc = { ...owner, approvals: { ...owner.approvals } };
  const locked = /** @type {string[]} */ ([]);
  if (managed.permissionMax !== undefined) {
    doc.permissionMax = stricterMode(owner.permissionMax, managed.permissionMax);
    locked.push('permissionMax');
  }
  if (managed.approvals) {
    for (const k of /** @type {const} */ (['remindMinutes', 'pauseMinutes'])) {
      if (managed.approvals[k] === undefined) continue;
      doc.approvals[k] = Math.min(owner.approvals[k], managed.approvals[k]);
      locked.push(`approvals.${k}`);
    }
  }
  for (const b of EXTRA_BLOCKS) {
    if (managed[b.name] === undefined || !b.merge) continue;
    doc[b.name] = b.merge(owner[b.name], managed[b.name]);
    locked.push(b.name);
  }
  return { doc, locked };
}

/** The document with its keys in a fixed order, so equal documents hash alike. */
const canonical = (/** @type {any} */ v) =>
  JSON.stringify(v, (_k, x) =>
    isObj(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );

/** The SHA-256 of the canonical effective document: what `host.status` and `host.policy` report, and what two ends compare. */
export const policyGeneration = (/** @type {any} */ doc) => sha256Hex(canonical(doc));

/** The wire parser for `host.policy`. @param {(m: string) => Error} bad */
export const policyParsers = (bad) => ({
  'host.policy': (/** @type {any} */ p) => ({
    doc: parseOwnerPolicy(p.doc, bad),
  }),
});
export const POLICY_METHODS = Object.freeze(['host.policy']);
