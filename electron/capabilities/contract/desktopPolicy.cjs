// Desktop control policy (the desktop_* tools): the tier each app gets, what each action needs, the
// apps that are never granted, broad-reach warnings for the access card, key-name normalization and
// screenshot sizing. Pure functions only; tools/desktop.cjs does the asking and the acting.

const { normalizeCombo, keySequence, isSystemCombo, hasEscape } = require('./desktopKeys.cjs');
const {
  MAX_LONG_EDGE,
  MAX_PIXELS,
  HIGH_RES_LONG_EDGE,
  HIGH_RES_PIXELS,
  ZOOM_LONG_EDGE,
  highResModel,
  screenshotLimits,
  screenshotSize,
  toPoints,
  toPixels,
} = require('./desktopScreenshots.cjs');

/** Tiers, weakest first. read: screenshots only. click: left clicks and scrolling. full: everything. */
const TIERS = ['read', 'click', 'full'];
const TIER_LABEL = { read: 'View only', click: 'Click and scroll', full: 'Full control' };
const tierRank = (t) => TIERS.indexOf(t);

/** "com.example.*" matches com.example and anything under it; otherwise an exact, case-insensitive id. */
function matches(pattern, bundleId) {
  if (!bundleId) return false;
  const id = String(bundleId).toLowerCase();
  const p = String(pattern).toLowerCase();
  if (p.endsWith('.*')) {
    const stem = p.slice(0, -2);
    return id === stem || id.startsWith(stem + '.');
  }
  return id === p;
}
const anyMatch = (list, bundleId) => list.some((p) => matches(p, bundleId));

/** Web browsers: visible in screenshots, never clicked or typed into (use the browser tools for the web). */
const BROWSERS = [
  'com.apple.Safari',
  'com.apple.SafariTechnologyPreview',
  'com.google.Chrome',
  'com.google.Chrome.*',
  'org.chromium.Chromium',
  'org.mozilla.firefox',
  'org.mozilla.firefoxdeveloperedition',
  'org.mozilla.nightly',
  'com.microsoft.edgemac',
  'com.microsoft.edgemac.*',
  'company.thebrowser.Browser',
  'company.thebrowser.dia',
  'com.brave.Browser',
  'com.brave.Browser.*',
  'com.operasoftware.Opera',
  'com.operasoftware.OperaGX',
  'com.vivaldi.Vivaldi',
  'app.zen-browser.zen',
  'com.kagi.kagimacOS',
  'org.torproject.torbrowser',
  'com.duckduckgo.macos.browser',
  'ai.perplexity.comet',
  'net.imput.helium',
  'org.waterfoxproject.waterfox',
  'org.mozilla.librewolf',
];

/** Terminals, IDEs and script runners: left clicks and scrolling only (typing there runs code). */
const CLICK_ONLY = [
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'dev.warp.Warp-Stable',
  'dev.warp.*',
  'net.kovidgoyal.kitty',
  'io.alacritty',
  'org.alacritty',
  'com.github.wez.wezterm',
  'co.zeit.hyper',
  'com.mitchellh.ghostty',
  'org.tabby',
  'com.microsoft.VSCode',
  'com.microsoft.VSCodeInsiders',
  'com.vscodium',
  'com.todesktop.230313mzl4w4u92',
  'com.exafunction.windsurf',
  'dev.zed.Zed',
  'dev.zed.Zed-Preview',
  'com.jetbrains.*',
  'com.google.android.studio',
  'com.apple.dt.Xcode',
  'com.sublimetext.*',
  'com.panic.Nova',
  'org.vim.MacVim',
  'org.gnu.Emacs',
  'com.apple.ScriptEditor2',
  'com.apple.Automator',
];

/** The tier an app gets, whatever the user grants: browsers read, terminals and IDEs click, the rest full. */
function tierOf(bundleId) {
  if (anyMatch(BROWSERS, bundleId)) return 'read';
  if (anyMatch(CLICK_ONLY, bundleId)) return 'click';
  return 'full';
}

/** MoPilot itself, and the Electron runtime a development build runs as: never granted. */
const HOST_BUNDLES = ['ai.mopilot.code', 'ai.mopilot.code.*', 'com.github.Electron', 'com.github.Electron.*'];
/**
 * Whether an app name is MoPilot itself (or one of its helper apps, or the Electron a development build runs as),
 * known without asking the computer-use helper: a program that names it is refused even when no lookup can run (#1362).
 * @param {unknown} name
 */
const isHostName = (name) => {
  const n = String(name)
    .trim()
    .replace(/\.app$/i, '')
    .toLowerCase();
  return n === 'mopilot' || n.startsWith('mopilot ') || n === 'electron';
};
/**
 * Where an agent that reached for MoPilot's own window goes instead: its projects and chats through list_sidebar
 * (#1724), its browser pane through the browser tools (#1362).
 */
const SELF_PANE_HINT =
  'Its projects and chats are listed by the list_sidebar tool, and its browser pane is reached through the browser tools (browser_*, or the Browser plugin\'s "iab" browser), never through computer use.';

/** Apps the access card warns about: granting them reaches far beyond the app itself. */
const SENTINELS = [
  {
    patterns: [
      'com.apple.Terminal',
      'com.googlecode.iterm2',
      'dev.warp.*',
      'net.kovidgoyal.kitty',
      'io.alacritty',
      'com.github.wez.wezterm',
      'com.mitchellh.ghostty',
      'co.zeit.hyper',
    ],
    warning: 'A terminal can run any command on this Mac.',
  },
  { patterns: ['com.apple.finder'], warning: 'Finder can open, move and delete any of your files.' },
  {
    patterns: ['com.apple.systempreferences', 'com.apple.Settings'],
    warning: 'System Settings controls security and privacy for the whole Mac.',
  },
  {
    patterns: [
      'com.apple.keychainaccess',
      'com.apple.Passwords',
      'com.apple.Passwords.*',
      'com.1password.*',
      'com.agilebits.*',
      'com.bitwarden.desktop',
      'com.lastpass.LastPass',
      'in.sinew.Enpass-Desktop',
      'org.keepassxc.keepassxc',
    ],
    warning: 'A password manager holds your passwords.',
  },
  {
    patterns: ['com.apple.ScriptEditor2', 'com.apple.Automator', 'com.apple.shortcuts'],
    warning: 'This app can run scripts and automations.',
  },
];

function warningOf(bundleId) {
  return SENTINELS.find((s) => anyMatch(s.patterns, bundleId))?.warning ?? null;
}

/** What each action needs from the app it reaches. */
const NEED = {
  screenshot: 'read',
  zoom: 'read',
  cursor_position: 'read',
  wait: null,
  mouse_move: 'click',
  left_click: 'click',
  double_click: 'click',
  triple_click: 'click',
  scroll: 'click',
  right_click: 'full',
  middle_click: 'full',
  left_click_drag: 'full',
  type: 'full',
  key: 'full',
  hold_key: 'full',
  left_mouse_down: 'full',
  left_mouse_up: 'click',
  read_clipboard: null,
  write_clipboard: null,
};

/** The tier an action needs (a left click with modifier keys held is a full-tier action), or null for none. */
function needOf(action, args = {}) {
  if (!Object.hasOwn(NEED, action)) return undefined;
  if (
    (action === 'left_click' || action === 'double_click' || action === 'triple_click') &&
    typeof args.text === 'string' &&
    args.text.trim()
  )
    return 'full';
  return NEED[action];
}

/** Actions that send input (and so take the screen: the lock, the overlay and the takeover consent). */
const INPUT = new Set([
  'mouse_move',
  'left_click',
  'double_click',
  'triple_click',
  'scroll',
  'right_click',
  'middle_click',
  'left_click_drag',
  'left_mouse_down',
  'left_mouse_up',
  'type',
  'key',
  'hold_key',
]);
/** Actions aimed at a point (the app under it is checked as well as the frontmost one). */
const POINTER = new Set([
  'mouse_move',
  'left_click',
  'double_click',
  'triple_click',
  'scroll',
  'right_click',
  'middle_click',
  'left_click_drag',
  'left_mouse_down',
]);
/** Actions that go to the frontmost app's keyboard focus (an explicit `app` may bring one forward first). */
const KEYBOARD = new Set(['type', 'key', 'hold_key']);

/** Long text goes to the helper in chunks, so Esc and the stop checks get a word in between. */
function chunkText(text, size = 50) {
  const chars = Array.from(String(text));
  const out = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

/* -- typing ------------------------------------------------------ */
/** Text this long, or with a line break, goes in through the clipboard (one paste, not a key per character). */
const PASTE_FROM = 200;

/**
 * The ways desktop_type tries to put text in, in order. `substitutions` false (the default): text never
 * goes through the keyboard's autocorrect and smart substitutions where another way exists: inserted
 * through accessibility, else typed with the app's substitutions turned off for the call. Long or
 * multi-line text is pasted first when a clipboard is there. Each way that can't run falls to the next.
 */
function typingRoutes(text, { substitutions = false, clipboard = false } = {}) {
  const t = String(text ?? '');
  const out = [];
  if (clipboard && (t.length >= PASTE_FROM || /[\r\n]/.test(t))) out.push('paste');
  if (!substitutions) out.push('ax');
  out.push('keys');
  return out;
}

/**
 * What the focused field should read after `text` replaced its selection, or null when that can't be
 * known (no readable value before, or a value cut short). `before`: {value, selection?: {location,
 * length}, truncated?} as the helper reads it (UTF-16 offsets, as JavaScript strings are).
 */
function expectedValue(before, text) {
  if (!before || typeof before.value !== 'string' || before.truncated) return null;
  const sel = before.selection;
  if (
    !sel ||
    !Number.isInteger(sel.location) ||
    !Number.isInteger(sel.length) ||
    sel.location < 0 ||
    sel.length < 0 ||
    sel.location + sel.length > before.value.length
  )
    return null;
  return before.value.slice(0, sel.location) + String(text) + before.value.slice(sel.location + sel.length);
}

/**
 * Whether typed text landed exactly: 'confirmed' (the field reads what it should), 'mismatch' (it reads
 * something else: autocorrect, an input mask or a length limit changed it, or it went elsewhere) or
 * 'unverifiable' (the field can't be read). Without a known selection, the field must have changed and
 * hold the text.
 */
function typingEffect(before, after, text) {
  if (!after || typeof after.value !== 'string' || after.truncated || !before || typeof before.value !== 'string' || before.truncated)
    return 'unverifiable';
  const want = expectedValue(before, text);
  if (want !== null) return after.value === want ? 'confirmed' : 'mismatch';
  return after.value !== before.value && after.value.includes(String(text)) ? 'confirmed' : 'mismatch';
}

/**
 * What an action did, as the model gets it: effect confirmed (the app or the helper reported it done),
 * mismatch (it ran, and what the app shows differs from what was asked), unverifiable (posted, with
 * nothing to confirm it landed) or refused; route ax (accessibility), window or global (events posted at
 * the pointer); a reason when refused.
 */
function actionRecord(action, effect, route, extra = {}) {
  const r = { action, effect, route };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== '') r[k] = v;
  return r;
}

/**
 * What a posted click did, from the helper's input.click answer: a click the helper finished through
 * accessibility (`fallback` press: the element in an out-of-process panel was pressed; select: the row
 * the click left unselected was selected) is confirmed on route ax; otherwise it was posted at the pointer
 * with nothing to confirm it. `activated` false: the window's app didn't come forward first, so the click
 * may only have activated it.
 * @param {{ fallback?: unknown, activated?: unknown } | null | undefined} r
 * @returns {{ effect: 'confirmed' | 'unverifiable', route: 'ax' | 'global', extra: { fallback?: string, activated?: false } }}
 */
function clickOutcome(r) {
  const fallback = r?.fallback === 'press' || r?.fallback === 'select' ? r.fallback : undefined;
  /** @type {{ fallback?: string, activated?: false }} */
  const extra = {};
  if (fallback) extra.fallback = fallback;
  if (r?.activated === false) extra.activated = false;
  return fallback ? { effect: 'confirmed', route: 'ax', extra } : { effect: 'unverifiable', route: 'global', extra };
}

/**
 * What a snapshot showed of an element, for the helper to check it again before acting (`expectElement`):
 * its role, and its title and description when it had them. Element ids are child-index paths, so after the
 * UI changes an id can name another control; the helper refuses an element that no longer matches
 * (elementMismatch in native/helper/Sources/HelperCore/Elements.swift). Values change as the user types,
 * so they are left out. The snapshot already holds at most 200 characters of each, as the helper compares them.
 * @param {{ role?: unknown, title?: unknown, description?: unknown }} n a node of ax.snapshot or app.screenshot's tree
 * @returns {{ role: string, title?: string, description?: string }}
 */
function identityOf(n) {
  /** @type {{ role: string, title?: string, description?: string }} */
  const out = { role: typeof n.role === 'string' ? n.role : '' };
  for (const k of /** @type {const} */ (['title', 'description'])) {
    const v = n[k];
    if (typeof v === 'string' && v) out[k] = v;
  }
  return out;
}

/** True when two identities (identityOf) name the same element. */
const sameIdentity = (a, b) => a.role === b.role && (a.title ?? '') === (b.title ?? '') && (a.description ?? '') === (b.description ?? '');

module.exports = {
  identityOf,
  sameIdentity,
  TIERS,
  TIER_LABEL,
  tierRank,
  matches,
  anyMatch,
  BROWSERS,
  CLICK_ONLY,
  tierOf,
  HOST_BUNDLES,
  isHostName,
  SELF_PANE_HINT,
  warningOf,
  needOf,
  INPUT,
  POINTER,
  KEYBOARD,
  normalizeCombo,
  keySequence,
  isSystemCombo,
  hasEscape,
  MAX_LONG_EDGE,
  MAX_PIXELS,
  HIGH_RES_LONG_EDGE,
  HIGH_RES_PIXELS,
  ZOOM_LONG_EDGE,
  highResModel,
  screenshotLimits,
  screenshotSize,
  toPoints,
  toPixels,
  chunkText,
  PASTE_FROM,
  typingRoutes,
  expectedValue,
  typingEffect,
  actionRecord,
  clickOutcome,
};
