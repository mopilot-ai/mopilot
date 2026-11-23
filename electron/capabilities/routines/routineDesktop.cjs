// Action memory on the desktop (#3571, G4): the desktop_app_* calls of a turn as replayable steps, and finding their
// targets again. A step names its app as the call did and its element by accessibility identity (role and label, and
// its place among twins), never by element_index or a coordinate, which mean nothing in the next screenshot. A replay
// takes a desktop_app_screenshot through the Registry first (its own call, with every gate a model's has), then
// finds the element in that window's fresh list.
const { noteIgnored } = require('../../ignored.cjs');

/** desktop_* tools a replay leaves out: they only look, or manage what the replay does not need. */
const DESKTOP_READS = new Set([
  'desktop_app_screenshot',
  'desktop_app_zoom',
  'desktop_app_ax_find',
  'desktop_app_list_windows',
  'desktop_app_release',
  'desktop_shortcut_list',
]);
/** desktop_* tools replayed as recorded: a menu path, a script, a Shortcut by name. */
const DESKTOP_VERBATIM = new Set(['desktop_app_menu', 'desktop_app_script', 'desktop_shortcut_run']);
/** desktop_app_* tools that act on an element (element_index, a coordinate, or the focused one). */
const DESKTOP_TARGETED = new Set(['desktop_app_click', 'desktop_app_type', 'desktop_app_key', 'desktop_app_scroll', 'desktop_app_focus']);

/** Arguments without what names this run's screenshot (element indexes, coordinates, window ids). */
function bareDesktop(args) {
  const out = { ...args };
  for (const k of ['element_index', 'coordinate', 'window_id']) delete out[k];
  return out;
}

/**
 * The step a desktop_* call adds, or null for one that only looks. Anything a replay can't run for the user (a batch, a
 * drag, a file panel, full-screen control) is kept as unsupported, so a replay hands off there instead of skipping it.
 * @param {string} tool
 * @param {any} args
 * @param {Map<string, any>} anchors targetKey -> { app, el: { role, label, nth }, secret } | null
 * @param {(args: any) => string | null} targetKey
 */
function desktopStepOf(tool, args, anchors, targetKey) {
  if (DESKTOP_READS.has(tool)) return null;
  if (DESKTOP_VERBATIM.has(tool)) return { tool, args: bareDesktop(args) };
  if (!DESKTOP_TARGETED.has(tool)) return { tool, args: {}, unsupported: true };
  const key = targetKey(args);
  // the focused element, or the point of the last action in the window: what the step before set
  if (!key) return { tool, args: bareDesktop(args) };
  const a = anchors.get(key);
  const target = a?.el ? { app: a.app, el: a.el } : null;
  // a secure (password) field's text is never kept
  if (a?.secret && tool === 'desktop_app_type') return { tool, args: { app: args.app }, target, secret: true };
  return { tool, args: bareDesktop(args), target };
}

/**
 * The window state the app-scoped control keeps for a chat's app (tools/appScoped.cjs: per chat, per app, the window
 * last captured and its elements), the app named as a call names it: its bundle id or its name.
 * @param {any} apps the AppScopedControl
 * @param {string} chatId
 * @param {unknown} app
 */
function windowOf(apps, chatId, app) {
  const want = String(app ?? '').toLowerCase();
  const s = apps?.sessions?.get(chatId);
  if (!s || !want) return null;
  for (const [key, a] of s.apps) {
    if (key !== want && String(a.name ?? '').toLowerCase() !== want) continue;
    return { app: key, w: a.windows.get(a.lastWindow) ?? null };
  }
  return null;
}

/** An element's identity among its window's: role, label, and its place among the ones that share both. */
function identityOf(elements, e) {
  const twins = elements.filter((x) => x.role === e.role && x.label === e.label);
  return { role: e.role, label: e.label, nth: twins.indexOf(e) };
}

/**
 * The desktop family's adapter for the recorder and the replay.
 * @param {() => any} appsOf the AppScopedControl, or null before computer use is up
 * @param {{ elementAt: (elements: any[], point: { x: number, y: number }) => any, toPoints: (geom: any, p: { x: number, y: number }) => any }} geometry
 */
function desktopAdapter(appsOf, geometry) {
  return {
    up: () => !!appsOf(),
    /** The anchors of a call's element targets, from the window's latest screenshot. */
    async anchorsBefore(/** @type {string} */ chatId, /** @type {string} */ _tool, /** @type {any} */ args) {
      const anchors = new Map();
      try {
        const found = windowOf(appsOf(), chatId, args?.app);
        const w = found?.w;
        /** @type {any} */
        let e = null;
        if (w && typeof args.element_index === 'number') e = w.elements[args.element_index - 1] ?? null;
        else if (w && Array.isArray(args.coordinate))
          e = geometry.elementAt(w.elements, geometry.toPoints(w.geom, { x: args.coordinate[0], y: args.coordinate[1] }));
        const key =
          typeof args.element_index === 'number'
            ? `el:${args.element_index}`
            : Array.isArray(args.coordinate)
              ? `at:${args.coordinate[0]},${args.coordinate[1]}`
              : null;
        if (key) anchors.set(key, e && found ? { app: found.app, el: identityOf(w.elements, e), secret: e.secure === true } : null);
      } catch (error) {
        // recording never keeps a call from running: the step is kept unanchored
        noteIgnored('anchor a desktop step for action memory', error);
      }
      return { anchors, url: null };
    },
    url: () => null,
  };
}

module.exports = { desktopStepOf, desktopAdapter, windowOf, identityOf, DESKTOP_READS, DESKTOP_TARGETED, DESKTOP_VERBATIM };
