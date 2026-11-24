// The background desktop_app_* tools' pure helpers: a window's numbered elements, key checks, helper errors, observed effects and hints, and the menu-disabled error.
const { clip } = require('../../../shared/clippedText.mjs');
const { ToolError } = require('../contract/registry.cjs');
const { helperError } = require('./computer.cjs');
const { outdatedHelperText } = require('../computer.cjs');
const P = require('../contract/desktopPolicy.cjs');
const { SCROLL_RETRY_HINT } = require('./appScopedLadder.cjs');
const { mayAct } = require('../contract/actionGuard.cjs');
const { TAKEOVER_WAIT_MS } = require('./takeoverWait.cjs');

/** Before an app lock or an input request: a call that may no longer act (Stop, Esc, its turn ended) ends as stopped. */
function stillActing() {
  if (!mayAct()) throw new ToolError('stopped by the user', 'refused');
}

const LISTED = new Set([
  'AXButton',
  'AXCheckBox',
  'AXRadioButton',
  'AXPopUpButton',
  'AXMenuButton',
  'AXMenuItem',
  'AXTextField',
  'AXTextArea',
  'AXSearchField',
  'AXComboBox',
  'AXLink',
  'AXSlider',
  'AXTab',
  'AXRow',
  'AXCell',
  'AXDisclosureTriangle',
  'AXIncrementor',
  'AXSwitch',
  'AXStaticText',
  'AXImage',
  'AXHeading',
  'AXWebArea',
  'AXScrollArea',
  'AXTable',
  'AXOutline',
  'AXList',
]);
const TEXT_ROLES = new Set(['AXTextField', 'AXTextArea', 'AXSearchField', 'AXComboBox']);
const MENU_ROLES = new Set(['AXPopUpButton', 'AXMenuButton']);
/** Containers listed for ax_find and scrolling but left out of the summary. */
const CONTAINERS = new Set(['AXWebArea', 'AXScrollArea', 'AXTable', 'AXOutline', 'AXList']);
const labelOf = (n) => [n.title, n.description, n.value, n.placeholder].filter((s) => typeof s === 'string' && s.trim()).join(' · ');

/**
 * A window's accessibility tree as numbered elements [1..] inside the window's frame: what element_index
 * and desktop_app_ax_find name. Centers are pixels of the frame; frames stay in global points.
 */
function indexWindowElements(tree, geom) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    const role = typeof n.role === 'string' ? n.role : '';
    const label = labelOf(n);
    const f = n.frame;
    if (f && f.w > 0 && f.h > 0 && LISTED.has(role) && (label || !['AXStaticText', 'AXImage'].includes(role))) {
      const c = P.toPixels(geom, { x: f.x + f.w / 2, y: f.y + f.h / 2 });
      if (c.x >= 0 && c.y >= 0 && c.x < geom.width && c.y < geom.height) {
        out.push({
          index: out.length + 1,
          id: n.id,
          role,
          label,
          name: [n.title, n.description].find((s) => typeof s === 'string' && s.trim()) || '',
          expect: P.identityOf(n),
          frame: f,
          center: c,
          enabled: n.enabled !== false,
          focused: n.focused === true,
          secure: n.secure === true,
          actions: Array.isArray(n.actions) ? n.actions : [],
        });
      }
    }
    for (const k of Array.isArray(n.children) ? n.children : []) walk(k);
  };
  walk(tree?.root);
  return out;
}

const elementLine = (e) =>
  `[${e.index}] ${e.role.replace(/^AX/, '')}${e.label ? ` "${clip(e.label.replace(/\s+/g, ' '), 80)}"` : ''} at (${e.center.x}, ${e.center.y})${[
    e.focused ? 'focused' : '',
    e.enabled ? '' : 'disabled',
    e.secure ? 'password' : '',
  ]
    .filter(Boolean)
    .map((f) => ` (${f})`)
    .join('')}`;

/**
 * The smallest element whose frame holds a point (global points), or null.
 * @template {{ frame: { x: number, y: number, w: number, h: number } }} E
 * @param {Iterable<E>} elements
 * @param {{ x: number, y: number }} p
 * @returns {E | null}
 */
function elementAt(elements, p) {
  /** @type {E | null} */
  let best = null;
  for (const e of elements) {
    const f = e.frame;
    if (p.x < f.x || p.y < f.y || p.x > f.x + f.w || p.y > f.y + f.h) continue;
    if (!best || f.w * f.h < best.frame.w * best.frame.h) best = e;
  }
  return best;
}

const NAV_KEYS = new Set(['up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown']);
const AX_KEYS = new Set(['return', 'enter', 'escape', 'delete', 'forwarddelete', 'cmd+a']);

/** A key the model names, normalized ("del" is backspace here, as the official tools have it). */
function normalizeAppKey(combo) {
  const parts = String(combo || '')
    .trim()
    .split('+')
    .map((p) => p.trim());
  if (/^del$/i.test(parts[parts.length - 1] || '')) parts[parts.length - 1] = 'delete';
  return P.normalizeCombo(parts.join('+'));
}

/** Where a refusal of a menu-presenting control or a shortcut sends the model when it is in a file panel. */
const PANEL_HINT = 'In a Save or Open panel, choose the folder (and file name) with desktop_app_file_panel.';

/** A right click in the background: its context menu would bring the app forward. */
function contextMenuRefusal() {
  return new ToolError(
    `unsupported(context_menu): a right-click menu would bring the app to the front. Use desktop_app_menu for the menu bar command, or the display-scope desktop_right_click. ${PANEL_HINT}`,
    'unsupported',
  );
}

/**
 * A click on a control that presents a menu (a pop-up button such as a Save panel's Where, an action menu).
 * @param {{ index: number, role: string }} el
 */
function menuControlRefusal(el) {
  return new ToolError(
    `unsupported(menu): [${el.index}] ${el.role.replace(/^AX/, '')} opens a menu, which would bring the app to the front. Use desktop_app_menu for the menu bar command instead. ${PANEL_HINT}`,
    'unsupported',
  );
}

/** Whether a key is Go to Folder (⇧⌘G, in any modifier order), which file panels and Finder share. */
const isGoToFolderKey = (mods, key) => key === 'g' && [...new Set(mods)].sort().join('+') === 'cmd+shift';

/**
 * Whether a key may go to an app in the background, or why not: menu shortcuts go through the menu
 * (the app ignores them, or worse, quits), and whole-Mac combinations mean nothing to one app.
 */
function keyVerdict(combo) {
  if (!combo) return { code: 'bad_args', message: 'Name a key, e.g. "return" or "tab"' };
  if (P.isSystemCombo(combo))
    return {
      code: 'unsupported',
      message: `unsupported(system_combo): ${combo} acts on the whole Mac, not on one app in the background; use the display-scope desktop_key (it needs systemKeyCombos from desktop_request_access).`,
    };
  const parts = combo.split('+');
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (AX_KEYS.has(combo)) return null;
  if (isGoToFolderKey(mods, key)) {
    return {
      code: 'unsupported',
      message: `unsupported(use_file_panel): ${combo} is Go to Folder, which an app in the background ignores. Use desktop_app_file_panel with folder (and file_name for a file): it finds a Save or Open panel in any of the app's windows, and in Finder goes through Go to Folder itself.`,
    };
  }
  if ((mods.includes('cmd') || mods.includes('ctrl')) && !NAV_KEYS.has(key)) {
    return {
      code: 'unsupported',
      message: `unsupported(use_app_menu): ${combo} is a menu shortcut; an app in the background ignores it. Use desktop_app_menu with the command's menu path instead. ${PANEL_HINT}`,
    };
  }
  return null;
}

/**
 * Refuses a desktop_app_type call's text before anything is written. Empty text inserted over a
 * selection deletes it (a model "selecting" a document to read it erased it, #1381 f2), so it goes only with replace.
 */
function assertTypeText(args, max) {
  const text = String(args.text ?? '');
  if (text === '' && args.mode !== 'replace')
    throw new ToolError(
      'text is empty, so there is nothing to type (over a selection it would delete it). To read a field, use desktop_app_ax_find; to clear one, pass mode: "replace" with text "".',
      'bad_args',
    );
  if (text.length > max) throw new ToolError(`At most ${max} characters per call`, 'bad_args');
}

/** A helper failure as the model should see it. */
function appHelperError(e) {
  if (e instanceof ToolError) return e;
  switch (e?.reason) {
    case 'unsupported':
      return new ToolError(e.message, 'unsupported');
    case 'not_running':
      return new ToolError(
        'The app is not running. Open it with desktop_open_application, then use the desktop_app_* tools.',
        'unavailable',
      );
    case 'window_gone':
      return new ToolError('That window is gone; call desktop_app_list_windows and pick another window_id.', 'changed');
    case 'element_gone':
    case 'element_changed':
      return new ToolError(`${e.message}`, 'changed');
    case 'method_not_found':
      return new ToolError(outdatedHelperText(e, 'for background control'), 'unavailable');
    case 'no_windows':
      return new ToolError(
        'The app has no window to capture. Open a window in it (desktop_app_menu, e.g. ["File", "New"]), then try again.',
        'unavailable',
      );
    case 'occluded':
      return new ToolError(
        'Another window of the app (a dialog or sheet) covers that point, so the click would land there. Take a new desktop_app_screenshot of the window in front (desktop_app_list_windows), or use element_index: accessibility works behind it.',
        'changed',
      );
    case 'window_changed':
      return new ToolError(
        'The window was resized since your latest desktop_app_screenshot, so its coordinates no longer hold. Take a new screenshot, then act.',
        'changed',
      );
    // desktop_app_script and the Shortcuts tools (appScopedScript.cjs)
    case 'script_refused':
      return new ToolError(`${e.message}. Nothing ran. Write the body for this app only, or use the other desktop_app_* tools.`, 'refused');
    case 'automation_denied':
      return new ToolError(
        `${e.message}. Nothing ran. Ask the user to turn it on, or use the other desktop_app_* tools; don't retry before they do.`,
        'denied',
      );
    case 'script_timeout':
      return new ToolError(`${e.message}. Split the work into shorter scripts, or give a longer timeout_s.`, 'failed');
    case 'no_shortcut':
      return new ToolError(`${e.message}. Call desktop_shortcut_list for the exact names.`, 'bad_args');
    case 'shortcuts_failed':
      return new ToolError(`Shortcuts failed: ${e.message}`, 'failed');
    default:
      return helperError(e);
  }
}

/** What to do when an action changed nothing observable: instead of repeating it blindly. */
const NO_CHANGE_HINT = {
  click:
    'Nothing changed after the click. Do not repeat it blindly: take a desktop_app_screenshot and check the target; it may be disabled, covered by a dialog, or need element_index or desktop_app_menu instead.',
  type: 'The field looks the same after typing. Check with a desktop_app_screenshot that the right field is targeted; target it by element_index, or use mode: "replace".',
  key: 'The key had no visible effect: what has keyboard focus may not take it. Click or desktop_app_focus the field first, or use desktop_app_menu for commands.',
  scroll: `Nothing moved: the content may be at its end, the point may not be over a scrollable area, or the app may ignore scroll events sent to a background window. Scroll at another point or element_index.${SCROLL_RETRY_HINT}`,
  drag: 'Nothing changed after the drag. Check the start point with a desktop_app_screenshot; some drags need the display-scope desktop_left_click_drag.',
  focus: 'Focus did not visibly move. Click the element instead.',
};

/**
 * What an action did, from what the route reported and what the helper saw change around it (`verify`:
 * {effect, evidence, settleMs}): a change it saw confirms an action that was only delivered, and seeing
 * nothing change makes it no_change. An accessibility write the app refused stays ineffective.
 */
function observedEffect(reported, verify) {
  if (!verify || typeof verify !== 'object' || !['confirmed', 'no_change', 'unverifiable'].includes(verify.effect))
    return { effect: reported };
  const effect = reported === 'ineffective' || verify.effect === 'unverifiable' ? reported : verify.effect;
  return {
    effect,
    ...(Array.isArray(verify.evidence) && verify.evidence.length ? { evidence: verify.evidence } : {}),
    ...(typeof verify.settleMs === 'number' ? { settle_ms: verify.settleMs } : {}),
  };
}

/** The record with a hint when the action changed nothing (unless it already says why). */
function withHint(record) {
  if ((record.effect === 'no_change' || record.effect === 'ineffective') && !record.reason && NO_CHANGE_HINT[record.action])
    return { ...record, hint: NO_CHANGE_HINT[record.action] };
  return record;
}

/** Whether a helper error says the menu item was found but is disabled (older helpers: unsupported(disabled)). */
function isMenuDisabled(e) {
  return e?.reason === 'menu_disabled' || (e?.reason === 'unsupported' && /^unsupported\(disabled\)/.test(String(e.message)));
}

/**
 * The error for a menu item that exists but is disabled: named as disabled (not missing), whether the
 * menu was refreshed first, and what to do instead of pressing it again. Generic, never per app.
 */
function menuDisabledError(appName, path, refreshed) {
  const where = `"${path.join(' > ')}"`;
  const fresh = refreshed
    ? " MoPilot refreshed the menu first, so this is the app's current state."
    : ' The app may not have updated this menu in the background yet.';
  return new ToolError(
    `${where} is in ${appName}'s menu but disabled right now.${fresh} An app with no key window (not in front) keeps its document commands disabled, Close and Save included: if those are all disabled, bring it forward with desktop_open_application and try again. The app also enables it only when the document state allows it: take a desktop_app_screenshot and check that a document window is open and that the command applies (it isn't already applied, there is a selection or an unsaved change), then try once more. If it stays disabled, use the window's own controls instead of the menu: for example, closing an unsaved document window (its close button, with desktop_app_click) brings up its save sheet, whose format and Save controls work in the background (desktop_app_file_panel chooses its folder). Don't change the app's global preferences to get around it.`,
    'disabled',
  );
}

/** The tier each background action needs, and what it is called in a refusal. */
const NEEDS = {
  click: ['click', 'clicks'],
  scroll: ['click', 'scrolling'],
  focus: ['click', 'moving focus'],
  type: ['full', 'typing'],
  key: ['full', 'keys'],
  drag: ['full', 'dragging'],
};

const isCoord = (c) => Array.isArray(c) && c.length === 2 && c.every((n) => typeof n === 'number' && Number.isFinite(n));
const center = (el) => ({ x: el.frame.x + el.frame.w / 2, y: el.frame.y + el.frame.h / 2 });

/** In brief foreground a click the helper posted to the process instead of the HID path says who owned the window at the point. */
const whyNotHid = (res) => (res?.ownerPid === undefined ? {} : { owner_pid: res.ownerPid, target_pid: res.targetPid });

module.exports = {
  whyNotHid,
  TEXT_ROLES,
  MENU_ROLES,
  CONTAINERS,
  indexWindowElements,
  elementLine,
  elementAt,
  normalizeAppKey,
  keyVerdict,
  assertTypeText,
  appHelperError,
  NO_CHANGE_HINT,
  observedEffect,
  withHint,
  TAKEOVER_WAIT_MS,
  isMenuDisabled,
  menuDisabledError,
  NEEDS,
  PANEL_HINT,
  contextMenuRefusal,
  menuControlRefusal,
  isCoord,
  center,
  stillActing,
};
