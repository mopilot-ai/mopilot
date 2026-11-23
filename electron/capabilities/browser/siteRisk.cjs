// Site risk classes for the in-app browser (IAB-03), offline by default. A page's URL is one of:
// - blocked: cloud metadata endpoints, local files and browser-internal pages. Agents never open or use them.
// - high: banking, brokerage, crypto exchanges, payment processors, government identity portals,
//   password managers, account security pages (a curated list and keyword heuristics in siteRisk.json),
//   and the private network (RFC 1918, link-local, CGNAT, .local and other non-public names; loopback
//   stays exempt for local development). Full access never covers a high-risk site: reading it needs the
//   user's approval (which may save it for good), and every action asks again until the user allows the
//   site's ordinary actions for good (origins.cjs, #5464).
// - normal: everything else.
// Banking, brokerage, crypto and payment sites also carry the financial warning; a URL with a user
// name or password in it carries the credentials warning (opening it asks every time).
//
// sensitiveAction() reads what the page agent reports about the element an action targets (pageAgent
// intent) and names a sensitive action: a delete, a purchase, a money transfer or trade, sending a
// message, submitting payment details, a password change or granting an app access to the account (an OAuth
// consent, consent.cjs). Those ask the user on any site, except that Full access covers the ordinary ones
// (fullAccessCovers()): payment details, password changes and consent still ask there.
//
// An optional remote check (SiteRisk remote, off by default) can add a category for a host the local
// data doesn't know: only 32-bit prefixes of SHA-256 host hashes leave the machine, and the full
// hashes are compared here.
const crypto = require('node:crypto');
const { consentUrl, grantName, consentVerb, consentDetail } = require('./consent.cjs');
const DATA = require('./siteRisk.json');
const { withTimeout } = require('../../platform/timeout.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { targetOf } = require('./payFormGrants.cjs');

const CATEGORIES = {
  cloud_metadata: {
    label: 'Cloud metadata endpoint',
    explanation: 'It can hand out machine credentials. Agents never open it.',
  },
  file: { label: 'Local file', explanation: "Local files can't be opened by agents in the browser." },
  browser_internal: { label: 'Browser internal page', explanation: "Browser-internal pages can't be opened by agents." },
  private_network: {
    label: 'Private network',
    explanation: 'A device or service on your network. Every action asks first.',
  },
  banking: { label: 'Banking site', financial: true },
  brokerage: { label: 'Brokerage site', financial: true },
  crypto: { label: 'Crypto exchange or wallet', financial: true },
  payments: { label: 'Payment service', financial: true },
  government_id: {
    label: 'Government identity portal',
    explanation: 'Holds government ID records. Every action asks first.',
  },
  password_manager: {
    label: 'Password manager',
    explanation: 'Holds saved passwords. Every action asks first.',
  },
  account_security: {
    label: 'Account security page',
    explanation: 'Manages sign-in and recovery. Every action asks first.',
  },
};
const FINANCIAL = "The agent won't pay, transfer or trade. Its actions ask first.";
const CREDENTIALS = {
  label: 'Sign-in details in the address',
  explanation: 'Opening it sends a user name or password to the site. Asks every time.',
};
const HIGH = new Set(Object.keys(CATEGORIES).filter((k) => !['cloud_metadata', 'file', 'browser_internal'].includes(k)));

/** Compiles the data file's lists once. */
function compile(data) {
  return {
    blockedHosts: new Set((data.blockedHosts || []).map((h) => String(h).toLowerCase())),
    blockedSchemes: new Set(data.blockedSchemes || []),
    privateSuffixes: data.privateSuffixes || [],
    domains: new Map(Object.entries(data.domains || {}).filter(([, c]) => HIGH.has(c))),
    pages: (data.pages || []).filter((p) => HIGH.has(p.category)),
    keywords: (data.keywords || [])
      .filter((k) => HIGH.has(k.category))
      .map((k) => ({ host: new RegExp(k.host, 'i'), path: k.path ? new RegExp(k.path, 'i') : null, category: k.category })),
  };
}
const DEFAULT = compile(DATA);

/** The four numbers of a dotted IPv4 host, or null. */
function ipv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return m ? m.slice(1).map(Number) : null;
}

/** An IPv4-mapped IPv6 host ([::ffff:a9fe:a9fe]) as dotted IPv4, or null. */
function mapped(host) {
  const m = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(host);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** Loopback: local development servers stay exempt. */
const isLoopbackHost = (h) => h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || /^127\./.test(h);

/** A host on the private network: RFC 1918, link-local, CGNAT, unique-local IPv6, or a non-public name. */
function isPrivateHost(h, lists = DEFAULT) {
  const v4 = ipv4(h);
  if (v4) {
    const [a, b] = v4;
    return (
      a === 10 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (h.startsWith('[')) return /^\[f[cd][0-9a-f]{0,2}:/.test(h) || /^\[fe[89ab][0-9a-f]?:/.test(h);
  return !h.includes('.') || lists.privateSuffixes.some((s) => h.endsWith(s));
}

/** The high-risk category the local data gives a host and path, or null. */
function categoryOf(host, pathname, lists = DEFAULT) {
  for (const p of lists.pages) if (p.host === host && pathname.startsWith(p.path)) return p.category;
  for (let h = host; h; h = h.includes('.') ? h.slice(h.indexOf('.') + 1) : '') {
    const c = lists.domains.get(h);
    if (c) return c;
  }
  for (const k of lists.keywords) if (k.host.test(host) && (!k.path || k.path.test(pathname))) return k.category;
  return null;
}

/** The result for a level and category, with the label and the explanation the card shows. */
function result(level, category, { host = '', credentials = false } = {}) {
  const c = category ? CATEGORIES[category] : null;
  const financial = !!c?.financial;
  const label = c ? c.label : credentials ? CREDENTIALS.label : '';
  const explanation = c ? c.explanation || FINANCIAL : credentials ? CREDENTIALS.explanation : '';
  return { level, category, label, explanation, financial, credentials, host };
}

const NORMAL = Object.freeze(result('normal', null));

/**
 * The risk class of a URL, offline: { level: 'blocked' | 'high' | 'normal', category, label,
 * explanation, financial, credentials, host }. about:blank and unparsable text are normal.
 */
function classify(url, lists = DEFAULT) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return NORMAL;
  }
  if (lists.blockedSchemes.has(u.protocol)) return result('blocked', u.protocol === 'file:' ? 'file' : 'browser_internal');
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return NORMAL;
  const credentials = !!(u.username || u.password);
  let host = u.hostname.toLowerCase().replace(/\.$/, '');
  host = mapped(host) || host;
  const o = { host, credentials };
  if (lists.blockedHosts.has(host)) return result('blocked', 'cloud_metadata', o);
  if (isLoopbackHost(host)) return result('normal', null, o);
  if (isPrivateHost(host, lists)) return result('high', 'private_network', o);
  const category = categoryOf(host, u.pathname, lists);
  return result(category ? 'high' : 'normal', category, o);
}

/** The text a tool error or result gives the model about a risky site. */
function riskNote(risk) {
  if (!risk || !risk.label) return '';
  if (risk.level === 'blocked') return `${risk.label}: agents can't open or use it.`;
  if (risk.level === 'high')
    return `${risk.label}: high risk. Reading it needs the user's approval in this chat and actions need approval.${risk.financial ? ' Never transfer funds, pay or trade here: hand those steps to the user.' : ''}`;
  return `${risk.label}.`;
}

/* ------------------------------------------------------------------ */
/* sensitive actions                                                    */
/* ------------------------------------------------------------------ */

const DELETE =
  /\b(delete|remove|erase|destroy|wipe|deactivate|terminate|revoke|discard|permanently|close (?:my |your |the )?account|cancel (?:my |your |the )?(?:subscription|membership|plan|order|account))\b/i;
const TRANSFER =
  /\b(transfer|send money|send payment|wire|withdraw|deposit|pay (?:a )?bill|zelle|trade|sell|place (?:trade|buy|sell)|swap|stake)\b/i;
const PURCHASE =
  /\b(buy|purchase|place (?:your )?order|complete (?:order|purchase|checkout)|checkout|check out|pay|confirm (?:payment|purchase|order|booking)|subscribe|donate|book now|reserve|upgrade now|start (?:free )?trial)\b/i;
/** A purchase-class name that actually pays, whatever else it also says. */
const PAYS =
  /\b(buy|purchase|place (?:your )?order|complete (?:order|purchase|checkout)|checkout|check out|pay|confirm (?:payment|purchase|order|booking))\b/i;
const MESSAGE = /\b(send|post|reply|publish|tweet|comment|submit review|invite)\b/i;
const PASSWORD = /\b(change|update|reset|set) (?:your |my )?password\b/i;
const SUBMIT_KEY = /^(enter|return)$/i;

/** What a kind of sensitive action asks the user about. */
const VERBS = {
  delete: 'delete something',
  transfer: 'transfer money or trade',
  purchase: 'make a purchase',
  send_message: 'send a message',
  payment: 'submit payment details',
  password_change: 'change a password',
  oauth_consent: 'grant an app access to your account',
  payment_entry: 'enter payment details',
  unreadable_frame: 'act inside a frame MoPilot could not read',
  unread_target: 'press keys on a control the focus moves to',
  consequential: 'run a page tool the page marks as consequential',
};

/**
 * What an action's target is when it lies in a cross-origin frame that could not be read (it went away, or is
 * nested where no session reaches): unknown, so a click, Enter or typing there asks, in Full access too.
 */
const UNREADABLE_FRAME = Object.freeze({ frame: true, unreadable: true });

/**
 * What a card says for a sensitive kind: the kind's verb, but a purchase-class name that only
 * subscribes, donates or books says that ("Subscribe" on a free signup is not "make a purchase").
 */
function verbOf(kind, text) {
  if (kind !== 'purchase') return VERBS[kind];
  const s = String(text);
  if (PAYS.test(s)) return VERBS.purchase;
  if (/\b(subscribe|start (?:free )?trial|upgrade now)\b/i.test(s)) return 'subscribe or start a plan';
  if (/\bdonate\b/i.test(s)) return 'donate';
  // what is left of the purchase-class names is booking and reserving
  return 'book or reserve';
}

/** The sensitive kind a button's name (or a dialog's message) suggests, or null. */
function kindOfName(name) {
  const s = String(name || '');
  if (!s) return null;
  if (PASSWORD.test(s)) return 'password_change';
  if (DELETE.test(s)) return 'delete';
  if (TRANSFER.test(s)) return 'transfer';
  if (PURCHASE.test(s)) return 'purchase';
  return MESSAGE.test(s) ? 'send_message' : null;
}

/** The sensitive kind submitting a form would be, from its fields and submit button, or null. */
function kindOfForm(form) {
  if (!form) return null;
  if (form.payment) return 'payment';
  if (form.newPassword || form.secrets >= 2) return 'password_change';
  return kindOfName(form.submit);
}

/** A key chord's main key ("shift+Enter" -> "Enter"). @param {string} k @returns {string} */
const mainKey = (k) => /** @type {string} */ (k.split('+').pop());

/** A key sequence's keys ("Enter", "ctrl+Enter", "a b"); a sequence of only spaces is the space bar (Playwright's " "). */
function keyList(keys) {
  const s = String(keys || '');
  if (s && !s.trim()) return ['Space'];
  return s.trim().split(/\s+/).filter(Boolean);
}

/** Whether a key sequence types characters (not only named keys). */
function typesKeys(keys) {
  return keyList(keys).some((k) => {
    const parts = k.split('+');
    const main = parts.pop() || '+';
    const mods = parts.map((p) => p.toLowerCase());
    if (mods.some((m) => ['ctrl', 'control', 'cmd', 'command', 'meta', 'super', 'win', 'windows'].includes(m))) return false;
    return [...main].length === 1 || main.toLowerCase() === 'space';
  });
}

/** Whether a key sequence presses Enter (with any modifiers): a submit. */
const submitsKeys = (keys) => keyList(keys).some((k) => SUBMIT_KEY.test(k.split('+').pop() || ''));

/** Roles whose element the space bar presses, as a click would (a link follows Enter only). */
const SPACE_PRESSES = new Set(['button', 'menuitem']);

/**
 * Whether a key sequence presses the focused control as a click does: Enter on a button or link, the space bar on a
 * button (#1384: "Pay" focused in a checkout frame and Enter pays). Typing into a field is judged as typing.
 */
const pressesKeys = (keys, intent) =>
  !!intent.button &&
  keyList(keys).some((k) => {
    const main = mainKey(k);
    return SUBMIT_KEY.test(main) || (/^space$/i.test(main) && SPACE_PRESSES.has(intent.role));
  });

/**
 * Whether a key sequence moves the focus (Tab) before a key that types, submits or presses: that key then acts on an
 * element nobody read ("Tab Enter" presses the next button, #1384), so it is judged unknown.
 */
const tabsThenActs = (keys) => {
  const list = keyList(keys);
  const at = list.findIndex((k) => /^tab$/i.test(mainKey(k)));
  return at >= 0 && list.slice(at + 1).some((k) => typesKeys(k) || submitsKeys(k));
};

/**
 * Whether an action needs the element it targets described (pageAgent intent): clicks, checks, typing, filling and
 * Enter do, and a drag from a known point (a bot check's slider refuses it, botCheck.cjs); other keys don't.
 */
function needsIntent(action) {
  if (!action) return false;
  if (action.kind === 'key') return typesKeys(action.keys) || submitsKeys(action.keys);
  if (action.kind === 'drag') return !!action.target;
  return action.kind === 'click' || action.kind === 'check' || action.kind === 'type' || action.kind === 'fill';
}

/** Whether an action puts text into the element (a password field refuses it). */
const typesText = (action) => action.kind === 'type' || action.kind === 'fill' || (action.kind === 'key' && typesKeys(action.keys));

/**
 * The sensitive action an action on an element is, or null. `intent` is what the page agent reports
 * (null when unknown); `action` is { kind: 'click' | 'key' | 'type' | 'fill' | 'dialog', keys?, accept?, message? }.
 * Returns { kind, verb, detail }.
 */
function sensitiveAction(intent, action) {
  /** @type {keyof typeof VERBS | null} */
  let kind = null;
  let detail = '';
  let verb = '';
  if (action.kind === 'dialog') {
    if (!action.accept) return null;
    kind = kindOfName(action.message);
    detail = action.message || '';
  } else if (action.kind === 'key' && tabsThenActs(action.keys)) {
    kind = 'unread_target';
    detail = action.keys;
  } else if (intent?.unreadable) {
    // the target is inside a frame nothing could read: whether it pays or deletes is unknown, so it asks
    if (action.kind === 'click' || typesText(action) || (action.kind === 'key' && submitsKeys(action.keys))) kind = 'unreadable_frame';
  } else if (intent) {
    const presses = (action.kind === 'click' && intent.button) || (action.kind === 'key' && pressesKeys(action.keys, intent));
    if (presses && intent.consent) {
      // granting an app access to the account (consent.cjs): the card names the app and what the page says it gets
      kind = 'oauth_consent';
      verb = consentVerb(intent.consent);
      detail = consentDetail(intent.consent, intent.name || '');
    } else if (presses) {
      // a submit that sends payment details is that, whatever its button says ("Pay $49.99", "Place order"), and so is
      // a button that pays from a form with card details but submits nothing itself (hosted card fields, a script
      // reads them): Full access covers a purchase but not payment details
      const named = kindOfName(intent.name);
      const pays = intent.submits || named === 'purchase' || named === 'transfer';
      kind = (pays && intent.form?.payment ? 'payment' : null) || named || (intent.submits ? kindOfForm(intent.form) : null);
      detail = intent.name || '';
    } else if (action.kind === 'key' && submitsKeys(action.keys) && intent.editable) {
      kind = kindOfForm(intent.form);
      detail = intent.form?.submit || '';
    } else if (typesText(action) && intent.payment) {
      kind = 'payment_entry';
      detail = intent.name || '';
    }
  }
  const limit = kind === 'oauth_consent' ? 240 : 120;
  if (!kind) return null;
  const out = { kind, verb: verb || verbOf(kind, detail), detail: String(detail).replace(/\s+/g, ' ').trim().slice(0, limit) };
  return { ...out, ...targetOf(intent) };
}

/**
 * The sensitive kinds Full access runs without a card on an ordinary site: deleting, buying, booking,
 * subscribing, moving money or trading, sending a message, uploading. Neither reference product gates these in
 * code in its most permissive mode (Claude Desktop's skip-all-permission-checks, Codex Browser Use: model
 * policy only), and money on a financial site is already covered by the high-risk class. Entering or
 * submitting payment details, changing a password and granting an app access (oauth_consent) still ask; an unknown
 * kind asks too.
 */
const FULL_ACCESS_COVERS = new Set(['delete', 'transfer', 'purchase', 'send_message', 'upload', 'consequential']);

/** Whether Full access runs this sensitive action without asking (on a site that is not high risk). */
const fullAccessCovers = (sensitive) => !!sensitive && FULL_ACCESS_COVERS.has(sensitive.kind);

/**
 * The sensitive action clicking an element described only by its name (Playwright MCP's `element`) is, or null; on a
 * consent page (`url`, consent.cjs) a grant name ("Allow", "Authorize Acme") is a consent.
 */
function sensitiveByName(name, url = '') {
  const kind = url && consentUrl(url) && grantName(name) ? 'oauth_consent' : kindOfName(name);
  return kind ? { kind, verb: verbOf(kind, name), detail: String(name).replace(/\s+/g, ' ').trim().slice(0, 120) } : null;
}

/**
 * The sensitive action a page's WebMCP tool is (webmcp.cjs), as a button with its name and description would be, or
 * one the page itself marks consequential; null for an ordinary one. A read-only hint never lowers it: it is the page's
 * claim. `url` is the page the tool is on ('' when unknown: it asks, as a frame nothing could read).
 * @param {{ name: string, description?: string, annotations?: { consequential?: boolean } }} tool @param {string} url
 */
function sensitiveTool(tool, url) {
  const text = `${String(tool.name).replace(/[_\-.]+/g, ' ')}: ${tool.description || ''}`;
  if (!url) return { kind: 'unreadable_frame', verb: VERBS.unreadable_frame, detail: String(tool.name).slice(0, 120) };
  const named = sensitiveByName(text, url);
  if (named) return named;
  return tool.annotations?.consequential
    ? { kind: 'consequential', verb: VERBS.consequential, detail: String(tool.name).slice(0, 120) }
    : null;
}

/* ------------------------------------------------------------------ */
/* the service: local classes, and the optional remote check            */
/* ------------------------------------------------------------------ */

/** SHA-256 (hex) of a host and each parent domain with at least two labels: what a remote check compares. */
function hostHashes(host) {
  const out = [];
  const labels = String(host).split('.');
  for (let i = 0; i <= labels.length - 2; i++) out.push(crypto.createHash('sha256').update(labels.slice(i).join('.')).digest('hex'));
  return out;
}

/**
 * A remote lookup against `endpoint`: POSTs 8-hex-digit prefixes of the host hashes and expects
 * { matches: [{ hash, category }] } with full hashes, compared here. Resolves to a category or null.
 */
function remoteLookup({ endpoint, fetch = globalThis.fetch }) {
  return async (hashes) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prefixes: hashes.map((h) => h.slice(0, 8)) }),
    });
    if (!res.ok) throw new Error(`site risk check failed: ${res.status}`);
    const body = await res.json();
    const hit = (Array.isArray(body?.matches) ? body.matches : []).find((m) => m && hashes.includes(m.hash) && HIGH.has(m.category));
    return hit ? hit.category : null;
  };
}

class SiteRisk {
  /**
   * @param {{ data?: object | null, remote?: ((hashes: string[]) => Promise<string | null>) | null,
   *           remoteEnabled?: () => boolean, timeoutMs?: number }} [o]
   *   remote: a host-hash lookup (remoteLookup), used only while remoteEnabled() (off by default)
   */
  constructor({ data = null, remote = null, remoteEnabled = () => false, timeoutMs = 1500 } = {}) {
    this.lists = data ? compile(data) : DEFAULT;
    this.remote = remote;
    this.remoteEnabled = remoteEnabled;
    this.timeoutMs = timeoutMs;
    /** host -> the remote category (or null for none) */
    this.cache = new Map();
    this.pending = new Map();
  }

  /** The risk class of a URL from the local data, upgraded by what a remote check already said. */
  classify(url) {
    const r = classify(url, this.lists);
    if (r.level !== 'normal' || !r.host) return r;
    const remote = this.cache.get(r.host);
    return remote ? result('high', remote, { host: r.host, credentials: r.credentials }) : r;
  }

  /** classify(), after asking the remote check about a host it hasn't seen (when it is on). Never throws. */
  async assess(url) {
    const r = this.classify(url);
    if (r.level !== 'normal' || !r.host || !this.remote || !this.remoteEnabled() || this.cache.has(r.host)) return r;
    let check = this.pending.get(r.host);
    if (!check) {
      check = Promise.resolve()
        .then(() => this.lookupHost(r.host))
        .finally(() => this.pending.delete(r.host));
      this.pending.set(r.host, check);
    }
    await check;
    return this.classify(url);
  }

  async lookupHost(host) {
    try {
      if (!this.remote || !this.remoteEnabled()) return;
      const category = await withTimeout(this.remote(hostHashes(host)), this.timeoutMs, 'timeout', { unref: true });
      if (!this.remote || !this.remoteEnabled()) return;
      this.cache.set(host, category && HIGH.has(category) ? category : null);
      if (this.cache.size > 5000) this.cache.delete(this.cache.keys().next().value);
    } catch (error) {
      // unknown: stays local, asked again next time
      noteIgnored('look up a site in the remote risk list', error);
    }
  }
}

module.exports = {
  SiteRisk,
  classify,
  categoryOf,
  isPrivateHost,
  isLoopbackHost,
  riskNote,
  sensitiveAction,
  sensitiveByName,
  sensitiveTool,
  UNREADABLE_FRAME,
  fullAccessCovers,
  FULL_ACCESS_COVERS,
  needsIntent,
  typesText,
  typesKeys,
  submitsKeys,
  pressesKeys,
  tabsThenActs,
  kindOfName,
  hostHashes,
  remoteLookup,
  compile,
  CATEGORIES,
  VERBS,
};
