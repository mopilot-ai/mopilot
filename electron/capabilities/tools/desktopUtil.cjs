// The desktop tools' helpers: the accessibility elements a screenshot lists, the agent's host processes, and the permission onboarding text.
const { ownTable } = require('../../../shared/ownTable.mjs');
const { prefixUnits } = require('../../../shared/textPrefix.mjs');
const { TRY_AGAIN } = require('../../../shared/uiLabels.mjs');
const { computerPermissionRecovery } = require('../../../shared/computerPermissionRecovery.mjs');
const { processTable } = require('../../platform/processTree.cjs');
const { HELPER_NAME, HELPER_BUNDLE_ID } = require('../computerContract.cjs');
const P = require('../contract/desktopPolicy.cjs');
const { MAX_ELEMENTS } = require('./desktopSpecs.cjs');

const INTERACTIVE = new Set([
  'AXButton',
  'AXCheckBox',
  'AXRadioButton',
  'AXPopUpButton',
  'AXMenuButton',
  'AXMenuItem',
  'AXMenuBarItem',
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
  'AXStaticText',
  'AXImage',
]);
const labelOf = (n) => [n.title, n.description, n.value].filter((s) => typeof s === 'string' && s.trim()).join(' · ');

/** The frontmost app's elements inside the screenshot, numbered [1..]: what element_index names. */
function indexElements(snap, geom, app, max = MAX_ELEMENTS) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object' || out.length >= max) return;
    const role = typeof n.role === 'string' ? n.role : '';
    const label = labelOf(n);
    const f = n.frame;
    if (f && f.w > 0 && f.h > 0 && INTERACTIVE.has(role) && (label || role !== 'AXStaticText')) {
      const c = P.toPixels(geom, { x: f.x + f.w / 2, y: f.y + f.h / 2 });
      if (c.x >= 0 && c.y >= 0 && c.x < geom.width && c.y < geom.height && !(role === 'AXImage' && !label)) {
        out.push({
          index: out.length + 1,
          id: n.id,
          pid: app.pid,
          bundleId: app.bundleId,
          app: app.name,
          role,
          label,
          expect: P.identityOf(n),
          frame: f,
          center: c,
          enabled: n.enabled !== false,
        });
      }
    }
    for (const k of Array.isArray(n.children) ? n.children : []) walk(k);
  };
  walk(snap?.root);
  return out;
}

/**
 * The smallest listed element whose frame holds a point (global points), or null.
 * @template {{ frame: { x: number, y: number, w: number, h: number } }} E
 * @param {E[] | null | undefined} elements
 * @param {{ x: number, y: number } | null | undefined} p
 * @returns {E | null}
 */
function elementAt(elements, p) {
  if (!p) return null;
  /** @type {E | null} */
  let best = null;
  for (const e of elements || []) {
    const f = e.frame;
    if (p.x < f.x || p.y < f.y || p.x > f.x + f.w || p.y > f.y + f.h) continue;
    if (!best || f.w * f.h < best.frame.w * best.frame.h) best = e;
  }
  return best;
}

const elementLine = (e) =>
  `[${e.index}] ${e.role.replace(/^AX/, '')}${e.label ? ` "${prefixUnits(e.label.replace(/\s+/g, ' '), 80)}"` : ''} at (${e.center.x}, ${e.center.y})${e.enabled ? '' : ' (disabled)'}`;

/** The pids of this process and its ancestors (the apps hosting the agent are never granted), up to 16 of them; this process alone when the core has no table. */
async function processAncestry(pid = process.pid, table = processTable) {
  const parents = new Map((await table()).map(([p, ppid]) => [p, ppid]));
  const out = new Set([pid]);
  let p = pid;
  while (out.size <= 16 && p > 1) {
    const parent = parents.get(p);
    if (parent === undefined || parent <= 1 || out.has(parent)) break;
    out.add(parent);
    p = parent;
  }
  return out;
}

const PANE = ownTable({
  screenRecording: { label: 'Screen Recording', url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture' },
  accessibility: { label: 'Accessibility', url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility' },
  inputMonitoring: { label: 'Input Monitoring', url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent' },
});

/** The pane of a macOS permission (Accessibility when the name is not one of ours). */
const paneOf = (permission) => PANE[permission] || PANE.accessibility;
const permissionLabel = (permission) => paneOf(permission).label;

/** The onboarding text for a missing macOS permission, naming the exact helper bundle that needs it. */
function onboarding(permission, helper = {}) {
  const pane = paneOf(permission);
  const who = `"${helper.name || HELPER_NAME}" (${helper.bundleId || HELPER_BUNDLE_ID}${helper.path ? `, ${helper.path}` : ''})`;
  const relaunch =
    permission === 'screenRecording'
      ? ' Screen Recording takes effect after the helper relaunches; MoPilot relaunches it on the next try.'
      : '';
  return `macOS reports ${who} cannot use ${pane.label} yet. MoPilot already asked macOS and shows a permission card in this chat (Request, Open System Settings, ${TRY_AGAIN}; pane ${pane.url}), so do not write Settings steps for the user: say the card is waiting and stop.${relaunch} ${computerPermissionRecovery(pane.label, helper.name || undefined)} Don't retry before they act on the card.`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { indexElements, elementAt, elementLine, processAncestry, onboarding, permissionLabel, sleep };
