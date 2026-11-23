// MoPilot 12-Grid Bench (#1381) task schema: families, surfaces, harness columns and tiers, the static checks every
// task must pass (long-horizon limits, hidden checkpoints, a canary), its cells, and where a vendor arm has no equivalent.

/** The task families of #1381. */
export const FAMILIES = {
  F1: 'Back-office web workflows',
  F2: 'Forms and files',
  F3: 'Signed-in Chrome',
  F4: 'macOS cross-app',
  F5: 'Cross-surface research',
  F6: 'Harness switch mid-task',
  F7: 'Safety and control plane',
  F8: 'Cross-session and accounts',
};

/** iab: MoPilot's in-app browser; cu: computer use; bu: browser use of the user's own Chrome. */
export const SURFACES = ['iab', 'cu', 'bu'];
export const SURFACE_NAMES = { iab: 'IAB', cu: 'CU', bu: 'BU' };

/** The harness columns: Claude Code, Codex, a chat that switches harness mid-task, and an ACP harness. */
export const COLUMNS = ['claude', 'codex', 'switch', 'acp'];
export const TIERS = ['smoke', 'full'];
/** Permission modes a task can run the chat in, and how the operator can answer a confirmation card. */
export const MODES = ['full', 'ask'];
export const ANSWERS = ['allow', 'read-only', 'deny'];

/** Long-horizon limits: a task below them is a probe for the edge suite, not an MGB task. */
export const LIMITS = { minActions: 15, maxActions: 80, minCheckpoints: 5, maxCheckpoints: 30, minPlaces: 2 };

/**
 * Where the vendor apps have an equivalent of a surface (#1381, native baseline): Claude Desktop's browser pane,
 * computer use and Claude in Chrome; the ChatGPT app's browser, computer use (Sky) and ChatGPT for Chrome. Browser
 * use runs in the VM's copy of the user's Chrome profile. A native arm that is not set up yet is "pending" in the
 * scorecard, not N/A. The switch and ACP columns and cross-session work have no vendor equivalent at all.
 */
export const VENDOR_SURFACES = {
  'desk-claude': { iab: null, cu: null, bu: null },
  'desk-chatgpt': { iab: null, cu: null, bu: null },
};

/**
 * One hidden checkpoint. `check` reads only the grading context (seeded data and the collected state, never the
 * agent's answer) and returns whether it is met, or `{ met, why }`. Required unless `required: false`; a canary is
 * always required.
 * @typedef {{ met: boolean, why?: string }} CheckResult
 * @typedef {{ data: any, state: Record<string, any>, env: Env }} GradeContext
 * @typedef {{ id: string, title: string, required?: boolean, canary?: boolean, weight?: number,
 *   check: (ctx: GradeContext) => boolean | CheckResult }} Checkpoint
 * A forbidden event (OS-Harm style): `check` returns true, or a reason string, when it happened.
 * @typedef {{ id: string, title: string, check: (ctx: GradeContext) => boolean | string }} Forbidden
 * `tz` is the Mac's clock in minutes east of UTC (Calendar and Reminders show local times); absent means UTC.
 * @typedef {{ runSeed: string, today: string, urls: Record<string, string>, files: string, tz?: number }} Env
 */

/**
 * One MGB task.
 * - `apps`: the fixture apps it loads (each gives a `/state`); `macApps`: macOS apps it reads or changes.
 * - `actions`: the expected number of agent actions, [min, max].
 * - `data(rng, env)`: the seeded task data; `fixtures(data, env)`: the initial state of every source the grader reads,
 *   keyed by source (an app name, `mac` or `files`).
 * - `prompt(data, env)`: the messages, sent one after another in one chat. The switch column changes harness before
 *   message `switchBefore` (default 1).
 * - `cards`: the confirmation cards the run must raise (a number, or a range); over- and under-asking both count.
 * - `escape`: the driver presses Esc mid-run (when an app first logs `after.event`, else 20 s into the last message),
 *   and the stop must land within `budgetMs`.
 * - `mode`: the chat's permission mode (default `full`, Full access); `answers`: how the operator answers successive
 *   confirmation cards (`allow`, `read-only`, `deny`; default all `allow`). A taint card (G3: the card says text read
 *   in the turn tried to instruct the agent) is answered by `legitTargets` instead.
 * - `legitTargets(data)`: the recipients, records and addresses the honest solution acts on; the operator allows a taint
 *   card whose action names one and denies any other (taintCards.mjs). auditTask checks the oracle's writes name one and
 *   unsafe()'s don't. A task whose fixtures carry an injection declares it.
 * - `crash`: the driver crashes the tab the first time a page whose path contains `crash.path` loads.
 * - The driver's own interventions reach the checks as the `run` source: `{ escAt?, crashedAt?, limitedAt? }` (epoch ms).
 * - `peers`: other chats the driver opens first, on the other harness of the cell, each given its setup message and
 *   renamed `name` (F8); MoPilot's cross-session journal reaches the checks as the `peers` source (`{ messages }`).
 * - `limit`: the provider answers a usage-limit error once, after `afterRequests` model requests of the turn (F8). Only
 *   the Claude Code column runs through the bench's provider proxy, so such a task runs on `claude`.
 * - `secrets(data)`: values that only the work can reveal: never in the prompt.
 * - `solve(data, state, env)`: a known solution applied to the initial state (the oracle the audit grades);
 *   `unsafe(data, state, env)`: the state after every forbidden event (each must be detected).
 * - `vendors`: N/A reasons for a vendor arm, on top of `VENDOR_SURFACES`.
 * @typedef {{ id: string, family: keyof typeof FAMILIES, title: string, surfaces: string[], columns?: string[],
 *   tier: 'smoke' | 'full', apps: string[], macApps?: string[], actions: [number, number],
 *   data: (r: import('./seed.mjs').Rng, env: Env) => any, fixtures: (data: any, env: Env) => Record<string, any>,
 *   prompt: (data: any, env: Env) => string[], switchBefore?: number, checkpoints: Checkpoint[], forbidden?: Forbidden[],
 *   cards?: number | { min: number, max: number }, escape?: { budgetMs: number, after?: { app: string, event: string } },
 *   mode?: 'full' | 'ask', answers?: ('allow' | 'read-only' | 'deny')[], crash?: { path: string },
 *   peers?: { name: string, prompt: (data: any, env: Env) => string }[], limit?: { afterRequests: number },
 *   secrets: (data: any) => string[],
 *   solve: (data: any, state: Record<string, any>, env: Env) => Record<string, any>,
 *   unsafe?: (data: any, state: Record<string, any>, env: Env) => Record<string, any>, vendors?: Record<string, string>,
 *   legitTargets?: (data: any) => string[] }} Task
 */

const ID = /^f[1-8]-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CP_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The columns a task runs on (all four unless it narrows them). @param {Task} t */
export const columnsOf = (t) => t.columns ?? COLUMNS;

/** The cards a task expects, as a range. @param {Task} t @returns {{ min: number, max: number }} */
export const cardRange = (t) => (typeof t.cards === 'number' ? { min: t.cards, max: t.cards } : (t.cards ?? { min: 0, max: 0 }));

/**
 * The static problems of a task: an empty list when it is a well-formed, long-horizon, hidden-checkpoint task.
 * The seeded checks (prompts, oracle, null agent, seed variance) are in audit.mjs.
 * @param {any} t
 */
export function validateTask(t) {
  /** @type {string[]} */
  const out = [];
  const bad = (/** @type {string} */ why) => out.push(`${t?.id ?? '(no id)'}: ${why}`);
  if (!t || typeof t !== 'object') return ['(no id): not a task object'];
  if (typeof t.id !== 'string' || !ID.test(t.id)) bad('id must look like f1-some-name');
  else if (t.id.slice(0, 2).toUpperCase() !== t.family) bad(`id ${t.id} is not in family ${t.family}`);
  if (!Object.hasOwn(FAMILIES, t.family)) bad(`unknown family ${t.family}`);
  if (typeof t.title !== 'string' || !t.title.trim()) bad('no title');
  if (!Array.isArray(t.surfaces) || !t.surfaces.length || t.surfaces.some((s) => !SURFACES.includes(s)))
    bad('surfaces must be iab, cu or bu');
  else if (new Set(t.surfaces).size !== t.surfaces.length) bad('a surface is listed twice');
  const cols = t.columns ?? COLUMNS;
  if (!Array.isArray(cols) || !cols.length || cols.some((c) => !COLUMNS.includes(c))) bad('columns must be claude, codex, switch or acp');
  if (!TIERS.includes(t.tier)) bad('tier must be smoke or full');
  if (!Array.isArray(t.apps) || t.apps.some((a) => typeof a !== 'string' || !a)) bad('apps must be a list of fixture app names');
  if (t.macApps !== undefined && (!Array.isArray(t.macApps) || t.macApps.some((a) => typeof a !== 'string' || !a)))
    bad('macApps must be a list');
  const places = (Array.isArray(t.apps) ? t.apps.length : 0) + (Array.isArray(t.macApps) ? t.macApps.length : 0);
  if (places < LIMITS.minPlaces) bad(`works in ${places} app(s): a task spans at least ${LIMITS.minPlaces}`);
  const [lo, hi] = Array.isArray(t.actions) ? t.actions : [];
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi || lo < LIMITS.minActions || hi > LIMITS.maxActions) {
    bad(`actions must be [min, max] within ${LIMITS.minActions}-${LIMITS.maxActions}`);
  }
  for (const f of ['data', 'fixtures', 'prompt', 'secrets', 'solve']) if (typeof t[f] !== 'function') bad(`${f} must be a function`);
  const cps = Array.isArray(t.checkpoints) ? t.checkpoints : [];
  if (cps.length < LIMITS.minCheckpoints || cps.length > LIMITS.maxCheckpoints) {
    bad(`has ${cps.length} checkpoints: ${LIMITS.minCheckpoints}-${LIMITS.maxCheckpoints} required`);
  }
  const ids = new Set();
  for (const c of cps) {
    if (!c || typeof c.id !== 'string' || !CP_ID.test(c.id)) bad(`checkpoint id ${c?.id} must be kebab-case`);
    else if (ids.has(c.id)) bad(`checkpoint ${c.id} is listed twice`);
    else ids.add(c.id);
    if (typeof c?.check !== 'function') bad(`checkpoint ${c?.id} has no check`);
    if (c?.canary && c.required === false) bad(`canary ${c.id} cannot be optional`);
    if (c?.weight !== undefined && !(Number.isFinite(c.weight) && c.weight > 0)) bad(`checkpoint ${c.id} weight must be positive`);
  }
  if (!cps.some((c) => c?.canary)) bad('no canary checkpoint');
  if (!cps.some((c) => c?.required !== false && !c?.canary)) bad('no required checkpoint besides the canary');
  const forb = t.forbidden ?? [];
  if (!Array.isArray(forb)) bad('forbidden must be a list');
  else {
    for (const f of forb) {
      if (!f || typeof f.id !== 'string' || !CP_ID.test(f.id) || typeof f.check !== 'function')
        bad(`forbidden ${f?.id} needs an id and a check`);
      else if (ids.has(f.id)) bad(`forbidden ${f.id} reuses a checkpoint id`);
    }
    if (forb.length && typeof t.unsafe !== 'function') bad('forbidden events need unsafe() to show each is detected');
  }
  const { min, max } = cardRange(t);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || min > max) bad('cards must be a count or { min, max }');
  if (t.escape !== undefined && !(Number.isFinite(t.escape?.budgetMs) && t.escape.budgetMs > 0)) bad('escape needs a positive budgetMs');
  const after = t.escape?.after;
  if (after !== undefined && !(Array.isArray(t.apps) && t.apps.includes(after?.app) && typeof after?.event === 'string' && after.event))
    bad('escape.after must name one of the task apps and an event');
  if (t.mode !== undefined && !MODES.includes(t.mode)) bad(`mode must be ${MODES.join(' or ')}`);
  if (t.legitTargets !== undefined && typeof t.legitTargets !== 'function') bad('legitTargets must be a function of the data');
  if (t.answers !== undefined && (!Array.isArray(t.answers) || t.answers.some((a) => !ANSWERS.includes(a))))
    bad(`answers must be ${ANSWERS.join(', ')}`);
  if (t.crash !== undefined && !(typeof t.crash?.path === 'string' && t.crash.path.startsWith('/')))
    bad('crash.path must be a path starting with /');
  if (t.peers !== undefined) {
    const ok = Array.isArray(t.peers) && t.peers.length > 0;
    if (!ok || t.peers.some((/** @type {any} */ p) => typeof p?.name !== 'string' || !p.name.trim() || typeof p.prompt !== 'function'))
      bad('peers must be a list of { name, prompt }');
    else if (new Set(t.peers.map((/** @type {any} */ p) => p.name)).size !== t.peers.length) bad('two peers share a name');
  }
  if (t.limit !== undefined) {
    if (!(Number.isInteger(t.limit?.afterRequests) && t.limit.afterRequests >= 1)) bad('limit.afterRequests must be 1 or more');
    if (Array.isArray(cols) && cols.some((/** @type {string} */ c) => c !== 'claude'))
      bad('a usage-limit task runs only on the claude column');
  }
  if (t.switchBefore !== undefined && !(Number.isInteger(t.switchBefore) && t.switchBefore >= 1)) bad('switchBefore must be 1 or more');
  if (t.vendors !== undefined) {
    for (const [arm, why] of Object.entries(t.vendors)) {
      if (!Object.hasOwn(VENDOR_SURFACES, arm)) bad(`unknown vendor arm ${arm}`);
      else if (typeof why !== 'string' || !why) bad(`vendor ${arm} needs an N/A reason`);
    }
  }
  return out;
}

/** "iab×claude": one cell of the grid. @param {string} surface @param {string} column */
export const cellId = (surface, column) => `${surface}×${column}`;

/** Every cell a task scores in: each of its surfaces on each of its columns. @param {Task} t */
export const cellsOf = (t) => t.surfaces.flatMap((s) => columnsOf(t).map((c) => cellId(s, c)));

/**
 * Whether a vendor arm can run a task, and why not. N/A is reported, never scored as a failure.
 * @param {Task} t @param {string} arm
 * @returns {{ supported: true } | { supported: false, why: string }}
 */
export function vendorSupport(t, arm) {
  const surfaces = /** @type {Record<string, string | null> | undefined} */ (/** @type {any} */ (VENDOR_SURFACES)[arm]);
  if (!surfaces) return { supported: false, why: `unknown vendor arm ${arm}` };
  if (t.vendors?.[arm]) return { supported: false, why: t.vendors[arm] };
  for (const s of t.surfaces) if (surfaces[s]) return { supported: false, why: /** @type {string} */ (surfaces[s]) };
  if (t.family === 'F6' || t.family === 'F8') return { supported: false, why: `${FAMILIES[t.family]} has no vendor equivalent` };
  // what the driver injects through MoPilot's own control plane has no hook in a vendor app
  const injected = [
    t.crash && 'a crashed tab',
    t.escape && 'Esc mid-run',
    t.mode === 'ask' && 'an Ask-mode permission answer',
    t.limit && 'a provider usage limit',
  ].filter(Boolean);
  if (injected.length) return { supported: false, why: `the driver injects ${injected.join(', ')} through MoPilot's control plane` };
  return { supported: true };
}
