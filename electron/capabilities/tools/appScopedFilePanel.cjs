// desktop_app_file_panel: choosing the folder (and file name) in a macOS Save or Open panel of an app in the background.
const os = require('node:os');
const path = require('node:path');
const { ToolError } = require('../contract/registry.cjs');
const P = require('../contract/desktopPolicy.cjs');
const { appHelperError } = require('./appScopedUtil.cjs');
const { mayForeground, foregroundNote, laddered } = require('./appScopedLadder.cjs');

/** @typedef {InstanceType<typeof import('./appScoped.cjs').AppScopedControl>} AppScopedControl */

const MAX_PATH = 1024;
const MAX_NAME = 255;
/** Whether text holds a control character (a newline would end the path the panel's field takes). */
const hasControl = (s) => [...s].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);

/**
 * The folder the model named, as an absolute path: "/..." or "~" / "~/..." (the user's home); anything
 * else (a relative path, "~other", control characters) is refused before the panel is touched.
 * @param {unknown} folder
 * @param {string} [home]
 */
function panelFolder(folder, home = os.homedir()) {
  if (typeof folder !== 'string' || !folder.trim()) throw new ToolError('folder is required, e.g. "~/Documents/Reports"', 'bad_args');
  const f = folder.trim();
  if (f.length > MAX_PATH || hasControl(f)) throw new ToolError('folder must be a plain path of at most 1024 characters', 'bad_args');
  let abs;
  if (f === '~' || f.startsWith('~/')) abs = path.join(home, f.slice(1));
  else if (f.startsWith('/')) abs = f;
  else throw new ToolError(`folder must be absolute or start with ~/ (got "${f.slice(0, 80)}")`, 'bad_args');
  const norm = path.posix.normalize(abs);
  return norm.length > 1 ? norm.replace(/\/+$/, '') : norm;
}

/**
 * The file name to save as: a name only (no folder), or undefined when none was given.
 * @param {unknown} name
 */
function panelFileName(name) {
  if (name === undefined || name === null) return undefined;
  if (typeof name !== 'string' || !name.trim()) throw new ToolError('file_name must be a non-empty name', 'bad_args');
  const n = name.trim();
  if (n.includes('/')) throw new ToolError('file_name is a name only; put the folder in folder', 'bad_args');
  if (n.length > MAX_NAME || hasControl(n) || n === '.' || n === '..')
    throw new ToolError('file_name must be a plain name of at most 255 characters', 'bad_args');
  return n;
}

/** A string the helper returned, clipped; undefined otherwise. */
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);

/**
 * The tool: the name field, a standard folder's sidebar row and a file in an Open panel's list are set through
 * accessibility with the app behind; any other folder goes through the panel's Go to Folder, which macOS's panel
 * service takes only while its app is active, so the helper runs it inside the brief-foreground rung (the user's app
 * and pointer restored) when the ladder allows it. The panel is found wherever it is (a sheet, or a window of its own
 * such as TextEdit's Open panel); in Finder, which has no panel, its Go to Folder sheet goes there instead. With
 * confirm, the panel's default button (Save, Open) is pressed once the panel shows the folder (and file); an alert it
 * brings up (Replace) is reported, never answered.
 * @param {AppScopedControl} ctl
 * @param {any} c the call (chat, app, pid, helper, ctx, session)
 * @param {Record<string, unknown>} args
 */
async function filePanel(ctl, c, args) {
  const folder = panelFolder(args.folder);
  // models also call it file (#1381 f2)
  const fileName = panelFileName(args.file_name ?? args.file);
  const confirm = args.confirm === true;
  const id = ctl.windowIdOf(c, args);
  try {
    ctl.need(c, 'choosing a folder in a Save or Open panel', 'full');
    await ctl.preflight(c);
    // pressing Save or Open is the model's to flag as irreversible, like a click on the button would be
    const irr = confirm ? ctl.consequence(c, 'file_panel', args, {}, null) : null;
    if (irr) await ctl.confirm(c, 'file_panel', irr);
    await ctl.waitForUser(c);
    // (taking the app checks that the call may still act: Stop, Esc, its turn)
    ctl.lock(c.chatId, c.app, id ?? 0);
    // a folder outside the sidebar needs Go to Folder, which the panel takes only with its app briefly in front
    const foreground = mayForeground(ctl.ladder, c.app, 'file_panel');
    const r = await c.helper.call(
      'app.filePanel',
      ctl.base(c, {
        windowId: id,
        folder,
        ...(fileName ? { fileName } : {}),
        // in Finder, confirm opens the document in its default app: only an app this chat was granted
        ...(confirm ? { confirm, openGranted: [...ctl.desktop.granted(c.chatId).values()].map((g) => g.bundleId) } : {}),
        foreground,
      }),
    );
    // the panel changed under the latest screenshot: its element indexes no longer hold
    if (id != null) ctl.appState(c).windows.delete(id);
    const record = panelRecord(c, r, { id, folder, confirm });
    return [{ type: 'text', text: `${JSON.stringify(record)}\n${nextStep(r, record, id)}` }];
  } catch (e) {
    const err = needsForeground(appHelperError(e));
    const record = P.actionRecord('file_panel', err.code === 'unsupported' ? 'unsupported' : 'refused', 'none', { reason: err.message });
    throw Object.assign(new ToolError(`${err.message}\n${JSON.stringify(record)}`, err.code), { record });
  }
}

/**
 * The action record of a panel request. Effect: the panel shows the folder (confirmed), shows no location to compare
 * (unverifiable), or didn't do what was asked (ineffective: the folder, the file in an Open panel's list, or a confirm
 * that wasn't pressed).
 * @param {any} c @param {any} r the helper's answer @param {{ id: number | undefined, folder: string, confirm: boolean }} o
 */
function panelRecord(c, r, { id, folder, confirm }) {
  const why =
    r?.reached === false
      ? str(r?.message, 300) || 'the panel did not show the folder'
      : r?.selected === false
        ? 'that file is not in the folder’s list'
        : confirm && r?.confirmed === false
          ? str(r?.confirmMessage, 300) || 'the default button was not pressed'
          : undefined;
  const effect = why ? 'ineffective' : r?.reached === true ? 'confirmed' : 'unverifiable';
  const base = P.actionRecord('file_panel', effect, r?.route || 'ax', {
    app: c.app.name,
    window_id: id,
    panel_window_id: typeof r?.panelWindowId === 'number' && r.panelWindowId !== id ? r.panelWindowId : undefined,
    folder,
    location: str(r?.location, 120),
    file_name: str(r?.fileName, MAX_NAME),
    selected: str(r?.selected, MAX_NAME),
    pressed: str(r?.pressed, 40),
    opened: str(r?.opened, 80),
    closed: typeof r?.closed === 'boolean' ? r.closed : undefined,
    prompt: str(r?.prompt, 300),
    prompt_buttons: Array.isArray(r?.promptButtons) ? r.promptButtons.filter((b) => typeof b === 'string').slice(0, 6) : undefined,
    reason: why,
    note: r?.nameField === false ? 'this panel has no file name field (an Open panel); the name was not set' : undefined,
  });
  return r?.foreground
    ? laddered(base, 'foreground', { note: foregroundNote(c.app.name, 'file_panel', r.foreground), fg: r.foreground })
    : base;
}

/** What the model does next after a panel request. @param {any} r @param {any} record @param {number | undefined} id */
function nextStep(r, record, id) {
  const win = typeof r?.panelWindowId === 'number' ? r.panelWindowId : id;
  const shot = `take a desktop_app_screenshot${win != null ? ` of window ${win}` : ''}`;
  if (r?.reached === false)
    return 'The panel did not move to that folder. Check that the folder exists (create it first if it does not), then try again.';
  if (r?.selected === false)
    return `The panel shows the folder, but that file is not in its list: ${shot} to check the name, then call again with the name it shows.`;
  if (r?.finder && r?.opened) {
    return `Opened “${record.file_name}” in ${record.opened}, which stays in the background: desktop_app_list_windows for ${record.opened} finds its window.`;
  }
  if (r?.finder && r?.confirmed === false) return `Finder shows the folder, but the file was not opened: ${record.reason}.`;
  if (r?.finder) {
    const what = record.file_name ? `, with “${record.file_name}” selected` : '';
    return `Finder${win != null ? ` window ${win}` : ''} shows the folder${what}. ${record.file_name ? 'To open it, call again with confirm: true' : 'To open a file in it, call again with its file_name and confirm: true'}; ${shot} to check it.`;
  }
  if (r?.prompt !== undefined) {
    const buttons = (record.prompt_buttons || []).join(', ');
    return `${record.pressed ? `${record.pressed} brought up an alert` : 'An alert is up'} in the panel${buttons ? ` (buttons: ${buttons})` : ''}. Nothing in it was pressed: if it asks to replace a file, replace it only when the user wants that; ${shot}, then press a button by element_index with desktop_app_click.`;
  }
  if (r?.closed === true)
    return `The panel closed after ${record.pressed || 'the default button'}. Take a desktop_app_screenshot of the app to check the result (desktop_app_list_windows lists its windows).`;
  if (r?.confirmed === true)
    return `${record.pressed || 'The default button'} was pressed but the panel is still open: ${shot} to see why.`;
  if (r?.confirmed === false) return `Not pressed: ${record.reason}. ${shot[0].toUpperCase()}${shot.slice(1)} to check the panel.`;
  return `The panel is still open: ${shot} to check it, then call desktop_app_file_panel again with confirm: true (or press its Save or Open button by element_index with desktop_app_click; a click by coordinate does not reach the panel in the background).`;
}

/** A folder outside the sidebar with brief switching off: what the model can do instead. */
function needsForeground(err) {
  if (!/^unsupported\(needs_foreground\)/.test(err.message)) return err;
  return new ToolError(
    `${err.message}. Choose a sidebar folder instead (the home folder, Desktop, Documents, Downloads, Applications), save there and tell the user where the file is; or ask the user to turn on "Allow brief switching to the app" in Settings → Computer use.`,
    err.code,
  );
}

module.exports = { filePanel, panelFolder, panelFileName };
