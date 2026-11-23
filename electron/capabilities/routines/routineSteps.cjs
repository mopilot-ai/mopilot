// Action memory's steps (#3571, G4): a browser tool call a turn made, as a step a routine can replay (its tool, its
// arguments without refs or tab ids, the semantic anchor of what it acted on and the page it ran on), the values it typed
// as the routine's parameters, and a step's arguments filled in again for a run. Pure: no tabs, no store.

const { desktopStepOf } = require('./routineDesktop.cjs');

/** browser_computer actions that act on an element (a ref or a point). */
const POINTER = new Set(['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'hover', 'scroll_to']);
/** browser_computer actions a replay leaves out: they only look (the model looked to decide; a replay already knows). */
const LOOKS = new Set(['screenshot', 'zoom']);
/** Tools a replay leaves out: they find something for the next step, or manage what the replay does not need. */
const READS = new Set([
  'browser_find',
  'browser_tabs_close',
  'browser_tabs_context',
  'browser_tabs_mark',
  'browser_history_search',
  'browser_bookmarks_search',
  'browser_read_console_messages',
  'browser_read_network_requests',
  'browser_save_screenshot',
  'browser_gif_creator',
  'browser_resize_window',
]);
/** Tools whose arguments are replayed as recorded (a URL, a dialog's answer, a credential sheet's site, a script). */
const VERBATIM = new Set([
  'browser_navigate',
  'browser_tabs_create',
  'browser_handle_dialog',
  'browser_request_credentials',
  'browser_javascript_exec',
  'browser_script',
]);
/** Longest wait a replayed step keeps: pages settle after each action anyway. */
const MAX_WAIT_S = 5;
const MAX_PARAMS = 20;

/** The chrome_* tools whose browser_* tool has another name (chromeTools.cjs TOOLS[].via); the rest run browser_<name>. */
const CHROME_VIA = Object.freeze({
  tabs_context_mcp: 'browser_tabs_context',
  tabs_create_mcp: 'browser_tabs_create',
  tabs_close_mcp: 'browser_tabs_close',
  javascript_tool: 'browser_javascript_exec',
  upload_image: 'browser_file_upload',
  // chrome_browser_batch runs its actions itself (via null): it is a batch
  browser_batch: 'browser_batch',
});

/** The family a tool records and replays in: the in-app browser's browser_* or the user's Chrome's chrome_*. */
const prefixOf = (tool) => {
  const t = String(tool);
  return t.startsWith('chrome_') ? 'chrome_' : t.startsWith('desktop_') ? 'desktop_' : 'browser_';
};

/** The browser_* tool a call runs: itself, or the one a chrome_* tool runs on the user's Chrome. */
function baseOf(tool) {
  const t = String(tool);
  if (!t.startsWith('chrome_')) return t;
  const n = t.slice('chrome_'.length);
  return CHROME_VIA[n] ?? `browser_${n}`;
}

/** A tool's short name in a batch ("navigate") as its full one, in the batch's own family. */
const fullName = (name, prefix) => (/^(?:browser|chrome)_/.test(String(name)) ? String(name) : `${prefix}${name}`);

/** Arguments without what names this run's page (refs, coordinates, tab ids). */
function bare(args) {
  const out = { ...args };
  for (const k of ['ref', 'coordinate', 'tabId', 'tab_id', 'target', 'start_coordinate']) delete out[k];
  return out;
}

/** The key of the element a call targets, for its anchor: its ref, or its point. */
function targetKey(args) {
  if (typeof args?.ref === 'string') return `ref:${args.ref}`;
  if (typeof args?.element_index === 'number') return `el:${args.element_index}`;
  const c = args?.coordinate;
  return Array.isArray(c) && c.length === 2 ? `at:${c[0]},${c[1]}` : null;
}

/** The single calls one tool call made: a batch's actions, else the call itself. */
function callsOf(tool, args) {
  if (baseOf(tool) !== 'browser_batch') return [{ tool, args: args ?? {} }];
  return (Array.isArray(args?.actions) ? args.actions : []).map((a) => ({ tool: fullName(a?.name, prefixOf(tool)), args: a?.input ?? {} }));
}

/**
 * The page a step ran on, as a pattern: its origin and its path with id-like segments (digits, long hex) as `*`.
 * @param {string} url
 */
function pagePattern(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const path = u.pathname
    .split('/')
    .map((seg) => (/\d{3,}/.test(seg) || /^[0-9a-f-]{12,}$/i.test(seg) ? '*' : seg))
    .join('/');
  return { origin: u.origin, path };
}

/** Whether a page is where a step ran: the same origin, and the same path but for its `*` segments. */
function pageMatches(pattern, url) {
  if (!pattern) return true;
  const here = pagePattern(url);
  if (!here || here.origin !== pattern.origin) return false;
  const want = pattern.path.split('/');
  const got = here.path.split('/');
  return want.length === got.length && want.every((seg, i) => seg === '*' || seg === got[i]);
}

/**
 * The steps one successful call adds to a recording. `anchors`: the anchor of each target (targetKey) taken before the
 * call ran ({ steps, weak, secret } | { frame: true } | null); `url`: the page the call started on.
 * @param {string} tool
 * @param {any} args
 * @param {Map<string, any>} anchors
 * @param {string | null} url
 */
function stepsOfCall(tool, args, anchors, url) {
  const out = [];
  let page = url ? pagePattern(url) : null;
  for (const call of callsOf(tool, args)) {
    const step = stepOf(call.tool, call.args, anchors, page);
    if (step) out.push(step);
    // a batch's later actions run on the page its navigation opened: their page is not known here
    if (opens(call.tool)) page = null;
  }
  return out;
}

/** A step that opens its own page (its page is not checked, and the steps after it are on the page it opened). */
const opens = (tool) => baseOf(tool) === 'browser_navigate' || baseOf(tool) === 'browser_tabs_create';

/** Tools a replay can't run for the user: uploads, tab switches by id, sign-in hand-offs. */
const UNSUPPORTED = new Set(['browser_file_upload', 'browser_tabs_select', 'browser_request_signin']);
/** Reads a task's answer may rest on: replayed, with what they return given back to the model. */
const DATA_READS = new Set(['browser_get_page_text', 'browser_read_page']);
/** Acting tools that also return what they found. */
const DATA_ACTS = new Set(['browser_script', 'browser_javascript_exec']);
/** Tools that run several actions in one call, so one that failed may have done part of its work. */
const PARTIAL = new Set([...DATA_ACTS, 'browser_batch', 'desktop_app_script']);
/** The step such a call leaves when it fails: nothing of the call, and a replay hands off there. */
const failedStep = (/** @type {string} */ tool) => ({ tool, args: {}, unsupported: true, failed: true });
/** Whether a call's result says it failed without throwing: a desktop script's first line is its action record. */
function reportedFailure(/** @type {any} */ out) {
  const text = Array.isArray(out) ? out[0]?.text : null;
  if (typeof text !== 'string') return false;
  try {
    return JSON.parse(text.split('\n')[0])?.effect === 'failed';
  } catch {
    return false;
  }
}

function stepOf(tool, args, anchors, page) {
  if (prefixOf(tool) === 'desktop_') return desktopStepOf(tool, args, anchors, targetKey);
  const base = baseOf(tool);
  if (READS.has(base)) return null;
  // the interactive outline only locates what the next step clicks, and a step keeps its own anchor
  if (base === 'browser_read_page' && args?.filter === 'interactive') return null;
  // the page says which site it read: a replay reads only on the sites a routine recorded
  if (DATA_READS.has(base)) return { tool, args: bare(args), reads: true, ...(page ? { page } : {}) };
  if (UNSUPPORTED.has(base)) return { tool, args: {}, unsupported: true };
  if (VERBATIM.has(base)) return { tool, args: bare(args), ...(page && base !== 'browser_navigate' ? { page } : {}) };
  if (base === 'browser_form_input') return withTarget({ tool, args: bare(args) }, args, anchors, page);
  if (base !== 'browser_computer') return { tool, args: {}, unsupported: true };
  const action = args?.action;
  if (LOOKS.has(action)) return null;
  if (action === 'wait') return { tool, args: { action, duration: Math.min(Number(args.duration) || 1, MAX_WAIT_S) } };
  if (action === 'left_click_drag') return { tool, args: bare(args), unsupported: true };
  if (POINTER.has(action) || (action === 'scroll' && targetKey(args))) return withTarget({ tool, args: bare(args) }, args, anchors, page);
  // typing and keys go to the focus, which the step before set (the browser tools never type into a password field)
  return { tool, args: bare(args), ...(page ? { page } : {}) };
}

/** A step on an element: its anchor, or none (a replay hands off there); never the value typed into a password field. */
function withTarget(step, args, anchors, page) {
  const key = targetKey(args);
  const a = key ? anchors.get(key) : null;
  const target = a && Array.isArray(a.steps) ? { steps: a.steps, ...(a.weak ? { weak: true } : {}) } : null;
  const out = { ...step, target, ...(page ? { page } : {}) };
  if (a?.secret && baseOf(step.tool) === 'browser_form_input') return { ...out, args: {}, secret: true };
  return out;
}

/** Whether a step's result is what the task learned, which a run gives back to the model. */
const yieldsData = (step) => !!step.reads || DATA_ACTS.has(baseOf(step.tool));

/** The part of its routine a step belongs to: the message of the recorded chat it came from, from 1. */
const partOf = (step) => step.part ?? 1;

/** How many parts a routine's steps have. */
const partsOf = (steps) => steps.reduce((n, s) => Math.max(n, partOf(s)), 1);

/** The name of what a step acts on: its anchor's last named step ("Search"), else null. */
function targetName(step) {
  // a desktop element: its accessibility label
  if (step.target?.el) return step.target.el.label || null;
  const steps = step.target?.steps ?? [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.k === 'role' && s.name?.s) return s.name.s;
    if (s.k === 'text' && s.m?.s) return s.m.s;
  }
  return null;
}

/** A parameter's name from what it was typed into: lowercase words joined by underscores, at most 32 characters. */
function paramName(label, taken) {
  const base =
    String(label ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'text';
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
  taken.add(name);
  return name;
}

/** Where a step keeps the value it typed: browser_computer type's text, a form field's text value. */
function typedKey(step) {
  if (step.secret) return null;
  const base = baseOf(step.tool);
  if (base === 'browser_computer' && step.args.action === 'type' && typeof step.args.text === 'string') return 'text';
  if (base === 'browser_form_input' && typeof step.args.value === 'string') return 'value';
  if (base === 'desktop_app_type' && typeof step.args.text === 'string') return 'text';
  return null;
}

/**
 * Turns recorded steps into a routine's steps and parameters: each value typed (at most MAX_PARAMS) becomes `{{name}}`
 * named after what it was typed into, also inside a later URL that carries it. `params` already in the routine keep
 * their names (an update);
 * @param {any[]} recorded
 * @param {{ name: string, example: string }[]} [params]
 */
function parameterize(recorded, params = []) {
  const taken = new Set(params.map((p) => p.name));
  const out = [...params];
  /** @type {{ value: string, name: string }[]} */
  const seen = [];
  /** what the last element step acted on: typing goes to the field it focused, so it names what is typed */
  let focus = null;
  const steps = recorded.map((step) => {
    if (step.target) focus = targetName(step);
    // a new page has no focus of the old one
    if (opens(step.tool)) focus = null;
    const key = typedKey(step);
    if (key && step.args[key] && out.length < MAX_PARAMS) {
      const value = step.args[key];
      const known = seen.find((s) => s.value === value);
      const name = known?.name ?? paramName(targetName(step) ?? focus, taken);
      if (!known) {
        seen.push({ value, name });
        out.push({ name, example: value });
      }
      return { ...step, args: { ...step.args, [key]: `{{${name}}}` } };
    }
    if (opens(step.tool) && typeof step.args.url === 'string') {
      let url = step.args.url;
      for (const s of seen)
        for (const form of new Set([encodeURIComponent(s.value), encodeURIComponent(s.value).replace(/%20/g, '+')]))
          if (s.value.length >= 2 && url.includes(form)) url = url.split(form).join(`{{${s.name}}}`);
      return url === step.args.url ? step : { ...step, args: { ...step.args, url } };
    }
    return step;
  });
  return { steps, params: out };
}

/**
 * A step's arguments for a run: each `{{name}}` filled from `values`, else the parameter's recorded example (URL-encoded
 * inside a URL). Returns the names it had no value for.
 * @param {any} step
 * @param {{ name: string, example: string }[]} params
 * @param {Record<string, unknown>} values
 */
function fillArgs(step, params, values) {
  const missing = [];
  const valueOf = (name) => {
    if (Object.hasOwn(values, name) && values[name] != null) return String(values[name]);
    const p = params.find((x) => x.name === name);
    if (p) return p.example;
    missing.push(name);
    return '';
  };
  const args = { ...step.args };
  for (const [k, v] of Object.entries(args)) {
    if (typeof v !== 'string' || !v.includes('{{')) continue;
    const url = k === 'url';
    args[k] = v.replace(/\{\{([a-z0-9_]+)\}\}/g, (_m, name) => (url ? encodeURIComponent(valueOf(name)) : valueOf(name)));
  }
  return { args, missing };
}

/** One line for a step, as a person would say it: `left_click button "Search"`, `type {{query}}`, `navigate <url>`. */
function describeStep(step) {
  const short = step.tool.replace(/^(?:browser|chrome|desktop_app|desktop)_/, '');
  const base = baseOf(step.tool);
  const what = targetName(step);
  const on = what ? ` "${what.slice(0, 60)}"` : '';
  if (base === 'browser_computer') {
    const a = step.args.action;
    if (a === 'type') return `type ${JSON.stringify(String(step.args.text ?? '').slice(0, 60))}`;
    if (a === 'key') return `key ${String(step.args.text ?? '')}`;
    return `${a}${on}`;
  }
  if (base === 'browser_form_input') return step.secret ? `fill a password field${on}` : `fill${on}`;
  if (opens(step.tool)) return `${short} ${String(step.args.url ?? '').slice(0, 120)}`;
  if (base === 'desktop_app_type')
    return step.secret ? `type into a password field${on}` : `type ${JSON.stringify(String(step.args.text ?? '').slice(0, 60))}${on}`;
  if (base === 'desktop_app_key') return `key ${String(step.args.combo ?? '')}`;
  if (base === 'desktop_app_menu') return `menu ${(Array.isArray(step.args.path) ? step.args.path : []).join(' › ')}`;
  return `${short}${on}`;
}

module.exports = {
  DATA_READS,
  yieldsData,
  partOf,
  partsOf,
  baseOf,
  prefixOf,
  opens,
  DATA_ACTS,
  PARTIAL,
  failedStep,
  reportedFailure,
  CHROME_VIA,
  stepsOfCall,
  targetKey,
  callsOf,
  pagePattern,
  pageMatches,
  parameterize,
  fillArgs,
  describeStep,
  targetName,
  MAX_PARAMS,
};
