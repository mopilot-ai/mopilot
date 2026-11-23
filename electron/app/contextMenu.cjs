// Right-click menus in the app windows: Copy Image, Save Image As… and Show in Finder on pictures; the edit menu on text.
const nodePath = require('node:path');
const { fs } = require('../platform/ports/fs.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { api: electron } = require('../platform/ports/electronApi.cjs');

/** File extensions for the picture types a save names by default. */
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

/**
 * A picture's bytes and type: the file when its path is known, the inline data of a data URL, or what the URL serves
 * (asset and web pictures go through Electron's net, which knows the app's protocols).
 * @param {{ src?: string, path?: string }} image
 * @param {{ fetch(url: string): Promise<Response> }} net
 * @returns {Promise<{ bytes: Buffer, type: string }>}
 */
async function imageBytes({ src, path }, net) {
  if (path) return { bytes: await fs.promises.readFile(path), type: '' };
  if (!src) throw new Error('no picture to read');
  // data:<type>[;param=value…][;base64],<data>
  const data = /^data:([^;,]*)(?:;[^;,=]+=[^;,]*)*(;base64)?,(.*)$/s.exec(src);
  if (data) return { bytes: Buffer.from(data[2] ? data[3] : decodeURIComponent(data[3]), data[2] ? 'base64' : 'utf8'), type: data[1] };
  const res = await net.fetch(src);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { bytes: Buffer.from(await res.arrayBuffer()), type: (res.headers.get('content-type') ?? '').split(';')[0].trim() };
}

/** The name a save offers: the file's own, or the picture's name in its URL, or "image" with its type's extension. */
function saveName({ src, path }, type) {
  if (path) return nodePath.basename(path);
  if (src && !src.startsWith('data:')) {
    const last = decodeURIComponent(/** @type {string} */ (new URL(src).pathname.split('/').pop()));
    if (/\.[a-z0-9]+$/i.test(last)) return last;
  }
  return `image.${EXT[type] ?? 'png'}`;
}

/**
 * @param {{
 *   Menu: Pick<typeof import('electron').Menu, 'buildFromTemplate'>,
 *   BrowserWindow: Pick<typeof import('electron').BrowserWindow, 'fromWebContents'>,
 *   clipboard: Pick<Electron.Clipboard, 'write'>,
 *   ClipboardItem: typeof import('electron').ClipboardItem,
 *   nativeImage: Pick<typeof import('electron').nativeImage, 'createFromBuffer'>,
 *   dialog: Pick<Electron.Dialog, 'showSaveDialog'>,
 *   shell: Pick<Electron.Shell, 'showItemInFolder'>,
 *   net: { fetch(url: string): Promise<Response> },
 *   platform?: NodeJS.Platform,
 * }} deps
 */
function createContextMenus({
  Menu,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  nativeImage,
  dialog,
  shell,
  net,
  platform = process.platform,
}) {
  const revealLabel = platform === 'darwin' ? 'Show in Finder' : platform === 'win32' ? 'Show in Explorer' : 'Show in Folder';

  /** Copies the picture as PNG, the type every app pastes (a JPEG or WebP is decoded and re-encoded). */
  async function copyImage(image) {
    const picture = nativeImage.createFromBuffer((await imageBytes(image, net)).bytes);
    if (picture.isEmpty()) throw new Error('not a picture the clipboard can hold');
    const png = new Blob([new Uint8Array(picture.toPNG())], { type: 'image/png' });
    await clipboard.write([new ClipboardItem({ 'image/png': png })]);
  }

  async function saveImage(image, win) {
    const { bytes, type } = await imageBytes(image, net);
    const options = { defaultPath: saveName(image, type) };
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    // a picture the user saves where they chose is theirs to share, like a download: readable as Finder makes files
    if (!canceled && filePath) await fs.promises.writeFile(filePath, bytes, { mode: 0o644 });
  }

  /** The items for a picture; Show in Finder only when it is a file on disk. */
  function imageItems(/** @type {{ src?: string, path?: string }} */ image, win) {
    const act = (what, fn) => () => void fn().catch((error) => noteIgnored(what, error));
    /** @type {Electron.MenuItemConstructorOptions[]} */
    const items = [
      { label: 'Copy Image', click: act('copy an image', () => copyImage(image)) },
      { label: 'Save Image As…', click: act('save an image', () => saveImage(image, win)) },
    ];
    if (image.path) {
      const path = image.path;
      items.push({ type: 'separator' }, { label: revealLabel, click: () => shell.showItemInFolder(path) });
    }
    return items;
  }

  /** The edit menu for a field or a selection, each item enabled as the page reports it can. */
  function textItems(/** @type {Electron.ContextMenuParams} */ params) {
    const can = params.editFlags;
    if (params.isEditable) {
      return /** @type {Electron.MenuItemConstructorOptions[]} */ ([
        { role: 'undo', enabled: can.canUndo },
        { role: 'redo', enabled: can.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: can.canCut },
        { role: 'copy', enabled: can.canCopy },
        { role: 'paste', enabled: can.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: can.canSelectAll },
      ]);
    }
    return params.selectionText.trim() ? [{ role: 'copy' }] : [];
  }

  function popup(items, win) {
    if (items.length) Menu.buildFromTemplate(items).popup(win ? { window: win } : {});
  }

  return {
    /** Gives an app window its right-click menus (what the page itself doesn't handle). */
    attach(/** @type {Electron.WebContents} */ wc) {
      wc.on('context-menu', (_e, params) => {
        const win = BrowserWindow.fromWebContents(wc) ?? undefined;
        const items = params.mediaType === 'image' && params.srcURL ? imageItems({ src: params.srcURL }, win) : textItems(params);
        popup(items, win);
      });
    },
    /** The menu for a picture the page knows more about (its file on disk), asked for over menu:image. */
    showImageMenu(/** @type {Electron.WebContents} */ wc, /** @type {{ src?: string, path?: string }} */ image) {
      const win = BrowserWindow.fromWebContents(wc) ?? undefined;
      popup(imageItems(image, win), win);
    },
  };
}

/** The app windows' menus on Electron's own modules (electron/app/windows.cjs attaches them, ipc/window.cjs shows them). */
const appMenus = createContextMenus(electron);

module.exports = { createContextMenus, appMenus, imageBytes, saveName };
