// App-window right-click menus (electron/app/contextMenu.cjs): pictures get Copy Image, Save Image As… and Show in Finder; text the edit menu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createContextMenus, appMenus, imageBytes, saveName } = require('../electron/app/contextMenu.cjs');
const { register: registerWindowIpc } = require('../electron/app/ipc/window.cjs');
const ignored = require('../electron/ignored.cjs');

const PNG = Buffer.from('fake png bytes');

/** A harness around createContextMenus: records each popup's items and what the menu's actions did. */
function harness({
  platform = 'darwin',
  empty = false,
  save = { canceled: false, filePath: '' } as any,
  fetched = {} as Record<string, any>,
} = {}) {
  const popups: { items: any[]; options: any }[] = [];
  const copied: any[] = [];
  const revealed: string[] = [];
  const dialogs: any[][] = [];
  const win = { id: 'win' };
  const menus = createContextMenus({
    Menu: { buildFromTemplate: (items: any[]) => ({ popup: (options: any) => popups.push({ items, options }) }) },
    BrowserWindow: { fromWebContents: (wc: any) => (wc.windowless ? null : win) },
    clipboard: { write: async (items: any[]) => void copied.push(...items) },
    ClipboardItem: class {
      data: Record<string, Blob>;
      constructor(data: Record<string, Blob>) {
        this.data = data;
      }
    },
    nativeImage: {
      createFromBuffer: (bytes: Buffer) => ({ isEmpty: () => empty, toPNG: () => Buffer.concat([Buffer.from('png:'), bytes]) }),
    },
    dialog: {
      showSaveDialog: async (...args: any[]) => {
        dialogs.push(args);
        return save;
      },
    },
    shell: { showItemInFolder: (p: string) => revealed.push(p) },
    net: {
      fetch: async (url: string) => {
        const r = fetched[url];
        if (!r) throw new Error(`no fixture for ${url}`);
        return {
          ok: r.ok ?? true,
          status: r.status ?? 200,
          headers: { get: () => r.type ?? null },
          arrayBuffer: async () => new Uint8Array(r.bytes ?? PNG).buffer,
        };
      },
    },
    platform,
  });
  return { menus, popups, copied, revealed, dialogs, win };
}

const labels = (items: any[]) => items.map((it) => it.label ?? it.role ?? it.type);
/** Waits for a menu action's file reads and writes: until `done` holds, or fails after 5 s. */
async function until(done: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('the menu action did not finish');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('a picture with its file gets Copy Image, Save Image As… and Show in Finder, each doing its job', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-menu-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'shot.png');
  fs.writeFileSync(file, PNG);
  const target = path.join(dir, 'saved.png');
  const h = harness({ save: { canceled: false, filePath: target } });
  h.menus.showImageMenu({}, { src: 'data:image/png;base64,AA==', path: file });
  const [{ items, options }] = h.popups;
  assert.deepEqual(labels(items), ['Copy Image', 'Save Image As…', 'separator', 'Show in Finder']);
  assert.deepEqual(options, { window: h.win });

  items[0].click();
  await until(() => h.copied.length === 1);
  const [copy] = h.copied;
  assert.deepEqual(Object.keys(copy.data), ['image/png']);
  assert.equal(Buffer.from(await copy.data['image/png'].arrayBuffer()).toString(), 'png:fake png bytes');

  items[1].click();
  await until(() => fs.existsSync(target) && fs.readFileSync(target, 'utf8') === 'fake png bytes');
  assert.deepEqual(h.dialogs, [[h.win, { defaultPath: 'shot.png' }]]);
  assert.equal(fs.readFileSync(target, 'utf8'), 'fake png bytes');

  items[3].click();
  assert.deepEqual(h.revealed, [file]);
});

test('without a file there is no Show in Finder; a cancelled save writes nothing, and failures are only noted', async () => {
  const h = harness({ empty: true, save: { canceled: true } });
  h.menus.showImageMenu({ windowless: true }, { src: 'data:image/png;base64,' + PNG.toString('base64') });
  const [{ items, options }] = h.popups;
  assert.deepEqual(labels(items), ['Copy Image', 'Save Image As…']);
  // no window to own it: the menu pops up on its own, and so does the dialog
  assert.deepEqual(options, {});
  items[0].click();
  items[1].click();
  await until(() => h.dialogs.length === 1 && ignored.recentIgnored().some((e: any) => e.context === 'copy an image'));
  assert.deepEqual(h.copied, []);
  assert.deepEqual(h.dialogs, [[{ defaultPath: 'image.png' }]]);
  assert.ok(ignored.recentIgnored().some((e: any) => e.context === 'copy an image' && /clipboard can hold/.test(e.message)));
});

test("main's own context-menu: a page picture by its URL, a field's edit menu, a selection's Copy, and nothing elsewhere", async () => {
  const h = harness({ platform: 'win32', fetched: { 'codex-asset://local/a%20b.jpg': { type: 'image/jpeg; q=1' } } });
  const wc = new EventEmitter();
  // a page that has lost its window still gets a menu, unparented
  const orphan = Object.assign(new EventEmitter(), { windowless: true });
  h.menus.attach(orphan);
  orphan.emit('context-menu', {}, { mediaType: 'none', srcURL: '', isEditable: false, selectionText: 'x', editFlags: {} });
  assert.deepEqual(h.popups.shift()!.options, {});
  h.menus.attach(wc);
  const base = { mediaType: 'none', srcURL: '', isEditable: false, selectionText: '', editFlags: {} };
  wc.emit('context-menu', {}, { ...base, mediaType: 'image', srcURL: 'codex-asset://local/a%20b.jpg' });
  assert.deepEqual(labels(h.popups[0].items), ['Copy Image', 'Save Image As…']);
  h.popups[0].items[1].click();
  await until(() => h.dialogs.length === 1);
  assert.deepEqual(h.dialogs[0][1], { defaultPath: 'a b.jpg' });

  const flags = { canUndo: false, canRedo: true, canCut: true, canCopy: true, canPaste: false, canSelectAll: true };
  wc.emit('context-menu', {}, { ...base, isEditable: true, editFlags: flags });
  assert.deepEqual(
    h.popups[1].items.map((it: any) => [it.role ?? it.type, it.enabled]),
    [
      ['undo', false],
      ['redo', true],
      ['separator', undefined],
      ['cut', true],
      ['copy', true],
      ['paste', false],
      ['separator', undefined],
      ['selectAll', true],
    ],
  );
  wc.emit('context-menu', {}, { ...base, selectionText: ' picked ' });
  assert.deepEqual(labels(h.popups[2].items), ['copy']);
  // whitespace only, or an image with no URL: no menu at all
  wc.emit('context-menu', {}, { ...base, selectionText: '  ' });
  wc.emit('context-menu', {}, { ...base, mediaType: 'image' });
  assert.equal(h.popups.length, 3);
  // the reveal item's name follows the platform
  h.menus.showImageMenu(wc, { path: '/x.png' });
  assert.equal(h.popups[3].items[3].label, 'Show in Explorer');
  assert.equal(harness({ platform: 'linux' }).menus.showImageMenu(wc, { path: '/x.png' }), undefined);
});

test('the reveal item is Show in Folder on Linux', () => {
  const h = harness({ platform: 'linux' });
  h.menus.showImageMenu({}, { path: '/x.png' });
  assert.equal(h.popups[0].items[3].label, 'Show in Folder');
});

test('imageBytes reads data URLs, files and served pictures, and refuses a failed response', async () => {
  assert.deepEqual(await imageBytes({ src: 'data:image/svg+xml,%3Csvg%2F%3E' }, null), {
    bytes: Buffer.from('<svg/>'),
    type: 'image/svg+xml',
  });
  // parameters before ;base64 are skipped
  assert.deepEqual(await imageBytes({ src: 'data:image/png;charset=utf-8;base64,AQI=' }, null), {
    bytes: Buffer.from([1, 2]),
    type: 'image/png',
  });
  const net = {
    fetch: async (url: string) =>
      url.endsWith('gone')
        ? { ok: false, status: 404 }
        : { ok: true, headers: { get: () => null }, arrayBuffer: async () => new Uint8Array([1, 2]).buffer },
  };
  assert.deepEqual(await imageBytes({ src: 'https://x/pic' }, net), { bytes: Buffer.from([1, 2]), type: '' });
  await assert.rejects(imageBytes({ src: 'https://x/gone' }, net), /HTTP 404/);
  await assert.rejects(imageBytes({}, net), /no picture to read/);
});

test('saveName: the file name, the URL name with an extension, else image with the type', () => {
  assert.equal(saveName({ path: '/a/b/c.webp' }, ''), 'c.webp');
  assert.equal(saveName({ src: 'https://x/y/photo.jpeg?s=1' }, 'image/jpeg'), 'photo.jpeg');
  assert.equal(saveName({ src: 'https://x/y/render' }, 'image/webp'), 'image.webp');
  assert.equal(saveName({ src: 'https://x/' }, 'image/x-unknown'), 'image.png');
  assert.equal(saveName({ src: 'data:image/gif;base64,AA==' }, 'image/gif'), 'image.gif');
  assert.equal(saveName({}, ''), 'image.png');
});

test("menu:image shows the picture's menu for the window that asked, with only the picture's src and path", () => {
  const handlers = new Map<string, Function>();
  const shown: any[] = [];
  registerWindowIpc(
    { handle: (name: string, fn: Function) => handlers.set(name, fn) },
    { contextMenus: { showImageMenu: (...args: any[]) => shown.push(args) }, nativeTheme: new EventEmitter(), windows: [] },
  );
  const sender = { id: 7 };
  handlers.get('menu:image')!({ sender }, { src: 'data:x', path: '/p.png', extra: 1 });
  handlers.get('menu:image')!({ sender }, null);
  assert.deepEqual(shown, [
    [sender, { src: 'data:x', path: '/p.png' }],
    [sender, { src: undefined, path: undefined }],
  ]);
  // outside Electron the shared menus still build (their Electron members are filled in by the app process)
  assert.equal(typeof appMenus.attach, 'function');
});
