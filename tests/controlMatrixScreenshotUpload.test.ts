// Control-matrix cases for attaching a screenshot of a page to a form (group B, #1530): every screenshot a browser tool
// returns has an id, browser_save_screenshot writes one into the chat's upload folder, and the uploads (browser_file_upload,
// chrome_* file_upload and upload_image, the Codex plugin's setFiles) take it under the same per-call confirmation.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeTabs, OriginGrants, code } from './support/browser-host-tools/fixture.ts';

export const GUARDS = ['electron/capabilities/', 'shared/'];

const require = createRequire(import.meta.url);
const { createBrowserTools } = require('../electron/capabilities/browser/hostTools.cjs');
const { createChromeTools } = require('../electron/capabilities/browser/chromeTools.cjs');
const { ScreenshotShelf, writeShot, safeName, SUBFOLDER } = require('../electron/capabilities/browser/hostScreenshots.cjs');
const { inAppBrowserNote } = require('../electron/capabilities/channels/codexThreadContracts.cjs');
const { chromeBackendNote } = require('../electron/capabilities/browser/chromeBackend.cjs');
const { UPLOAD_HINT, screenshotUploadHint } = require('../electron/capabilities/browser/iabBackend/protocol.cjs');
const { isToolHidden } = require('../electron/capabilities/visibility.cjs');

const bases: string[] = [];
after(() => {
  for (const b of bases) fs.rmSync(b, { recursive: true, force: true });
});

/** A JPEG-ish payload the fake capture returns, so a saved file can be compared byte for byte. */
const PIXELS = Buffer.from('jpeg-bytes-of-the-email-page').toString('base64');
const FULL = Buffer.from('jpeg-bytes-of-the-whole-page').toString('base64');
const ID = /Screenshot ID: (ss_[0-9a-f]{8})\./;

/**
 * The browser tools over a fake tabs (the email page at mail.test), a real OriginGrants and a real upload folder.
 * `chrome`: the chrome_* tools over the same fake host (a Chrome tab id 7), as Claude in Chrome's surface.
 */
function world(o: { anchor?: string; ok?: boolean; folders?: boolean; chrome?: boolean; shelf?: any; allowSites?: boolean } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shotupload-'));
  bases.push(base);
  const uploads = path.join(base, 'uploads', 'c1');
  const asks: any[] = [];
  const grants = new OriginGrants({
    file: null,
    anchor: () => o.anchor ?? 'ask',
    ask: async () => (o.allowSites ? { decision: 'allow', scope: 'chat', level: 'write' } : { decision: 'deny' }),
  });
  grants.set('https://mail.test', 'write');
  grants.set('https://tracker.test', 'write');
  const tabs = makeTabs();
  Object.assign(tabs.tab, { url: 'https://mail.test/inbox/42', title: 'Invoice 42', backend: { tabId: 7 } });
  tabs.impl.capture = async () => ({ width: 800, height: 600, data: PIXELS });
  tabs.impl.captureFull = async () => ({ width: 800, height: 2400, data: FULL, truncated: false });
  tabs.impl.locate = async () => ({ x: 400, y: 300, w: 200, h: 100 });
  for (const k of ['captureFull', 'locate'])
    tabs[k] = (...a: any[]) => {
      tabs.calls.push([k, ...a]);
      return tabs.impl[k](...a);
    };
  const deps = {
    tabs,
    grants,
    shelf: o.shelf,
    folders: o.folders === false ? null : () => ({ uploads, downloads: path.join(base, 'downloads') }),
    confirm: async (_ctx: any, req: any) => (asks.push(req), o.ok ?? true),
  };
  const list = o.chrome ? createChromeTools(deps) : createBrowserTools(deps);
  const ctx = { chatId: 'c1', segmentId: 's1' };
  const call = (name: string, args: any = {}, c: any = ctx) =>
    list.find((t: any) => t.name === (o.chrome ? `chrome_${name}` : name)).handler(args, c);
  return { base, uploads, tabs, grants, asks, call, ctx };
}
const textOf = (out: any[]) =>
  out
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
const idOf = (out: any[]) => (textOf(out).match(ID) || [])[1];

test('CM-B28: a screenshot names an id, and browser_file_upload attaches it from the upload folder after the per-call confirmation', async () => {
  const w = world();
  const shot = await w.call('browser_computer', { action: 'screenshot' });
  // the image goes to the model as before (the page URL it carried is taken off), followed by its id
  assert.deepEqual(shot[1], { type: 'image', data: PIXELS, mimeType: 'image/jpeg' });
  const id = idOf(shot);
  assert.ok(id);
  // nothing is written until the upload asks for it
  assert.equal(fs.existsSync(path.join(w.uploads, SUBFOLDER)), false);

  w.tabs.tab.url = 'https://tracker.test/issues/new';
  const out = await w.call('browser_file_upload', { ref: 'ref_9', screenshots: [id] });
  const root = fs.realpathSync(w.uploads);
  const file = path.join(root, SUBFOLDER, `screenshot-mail.test-${id}.jpg`);
  assert.equal(fs.readFileSync(file, 'base64'), PIXELS, 'the file is the image the model saw');
  assert.deepEqual(w.tabs.called('setFiles'), [[w.tabs.tab, 'ref_9', [file]]]);
  // the card names the file (and so the page it shows) and the site it goes to
  assert.deepEqual(w.asks, [
    { tool: 'File upload', origin: 'https://tracker.test', summary: `Upload screenshot-mail.test-${id}.jpg to https://tracker.test` },
  ]);
  assert.match(out[0].text, /^Set 1 file on ref_9\./);

  // the same screenshot again is the same file; with a path beside it, both are set
  fs.writeFileSync(path.join(w.uploads, 'notes.txt'), 'n');
  await w.call('browser_file_upload', { ref: 'ref_9', paths: ['notes.txt'], screenshots: [id] });
  assert.deepEqual(w.tabs.called('setFiles')[1][2], [path.join(root, 'notes.txt'), file]);
  assert.deepEqual(fs.readdirSync(path.join(root, SUBFOLDER)), [path.basename(file)]);
});

test('CM-B28b: an upload of a screenshot the user refuses, an unknown id, another chat’s id or no upload folder sets nothing', async () => {
  const w = world({ ok: false });
  const id = idOf(await w.call('browser_computer', { action: 'screenshot' }));
  await assert.rejects(w.call('browser_file_upload', { ref: 'ref_9', screenshots: [id] }), code('denied'));
  await assert.rejects(
    w.call('browser_file_upload', { ref: 'ref_9', screenshots: ['ss_00000000'] }),
    code('bad_args', /^No screenshot ss_00000000 in this chat: take a screenshot and give the Screenshot ID its result names\.$/),
  );
  // ids are per chat: another chat's screenshot is not this chat's
  await assert.rejects(
    w.call('browser_file_upload', { screenshots: [id] }, { chatId: 'c2', segmentId: 's9' }),
    code('bad_args', /^No screenshot ss_/),
  );
  assert.deepEqual(w.tabs.called('setFiles'), []);
  const off = world({ folders: false });
  const other = idOf(await off.call('browser_computer', { action: 'screenshot' }));
  await assert.rejects(off.call('browser_file_upload', { screenshots: [other] }), code('disabled', /^File upload is turned off\.$/));
  await assert.rejects(off.call('browser_save_screenshot', {}), code('disabled', /^Saving screenshots is turned off\.$/));
  // Full access attaches without a card, as for any other file
  const full = world({ anchor: 'full', ok: false });
  const fid = idOf(await full.call('browser_computer', { action: 'screenshot' }));
  await full.call('browser_file_upload', { ref: 'ref_1', screenshots: [fid] });
  assert.equal(full.asks.length, 0);
  assert.equal(full.tabs.called('setFiles').length, 1);
});

test('CM-B29: browser_save_screenshot writes the viewport, a region, one element or the whole page into the upload folder and returns its path and id', async () => {
  const w = world();
  const root = () => fs.realpathSync(w.uploads);
  const view = await w.call('browser_save_screenshot', {});
  const id = idOf(view);
  const file = path.join(root(), SUBFOLDER, `screenshot-mail.test-${id}.jpg`);
  assert.equal(
    view[0].text,
    `Saved a screenshot of the viewport of t1 (800x600) to ${file}. Attach it with browser_file_upload (paths: [that file], or screenshots: ["${id}"]); the user confirms each upload. Tab t1 is at https://mail.test/inbox/42 (Invoice 42).`,
  );
  assert.deepEqual(view[1], { type: 'image', data: PIXELS, mimeType: 'image/jpeg' });
  assert.equal(fs.readFileSync(file, 'base64'), PIXELS);
  assert.deepEqual(w.tabs.called('capture').at(-1), [w.tabs.tab, { w: 800, h: 600 }, { region: null }]);

  // one element: its box, read after it was scrolled into view
  const el = await w.call('browser_save_screenshot', { ref: 'ref_4', name: 'invoice 42.png' });
  assert.deepEqual(w.tabs.called('locate'), [[w.tabs.tab, 'ref_4', { hit: true }]]);
  assert.deepEqual(w.tabs.called('capture').at(-1)[2], { region: [300, 250, 500, 350] });
  const ready = w.tabs.calls.filter((c: any[]) => c[0] === 'ready' || c[0] === 'locate').map((c: any[]) => c[0]);
  assert.deepEqual(ready.slice(-3), ['ready', 'locate', 'ready']);
  assert.match(
    el[0].text,
    new RegExp(`^Saved a screenshot of element ref_4 of t1 \\(800x600\\) to ${root()}/screenshots/invoice-42\\.jpg\\.`),
  );
  // a name that is taken gets a number
  const again = await w.call('browser_save_screenshot', { ref: 'ref_4', name: 'invoice 42.png' });
  assert.match(again[0].text, /screenshots\/invoice-42-2\.jpg\./);
  // its id attaches that same file, under the name the agent gave it (no second copy; found in the dev app)
  w.tabs.tab.url = 'https://tracker.test/new';
  await w.call('browser_file_upload', { ref: 'ref_2', screenshots: [idOf(el)] });
  assert.deepEqual(w.tabs.called('setFiles').at(-1)[2], [path.join(root(), SUBFOLDER, 'invoice-42.jpg')]);
  assert.equal(w.asks.at(-1).summary, 'Upload invoice-42.jpg to https://tracker.test');
  // a saved file the agent's folder lost is written again from the kept image
  fs.rmSync(path.join(root(), SUBFOLDER, 'invoice-42.jpg'));
  await w.call('browser_file_upload', { ref: 'ref_2', screenshots: [idOf(el)] });
  assert.deepEqual(w.tabs.called('setFiles').at(-1)[2], [path.join(root(), SUBFOLDER, `screenshot-mail.test-${idOf(el)}.jpg`)]);
  w.tabs.tab.url = 'https://mail.test/inbox/42';

  // an element taller than the viewport: the part the viewport shows, and the result says it was cut
  w.tabs.impl.locate = async () => ({ x: 400, y: 300, w: 200, h: 1400 });
  w.tabs.impl.capture = async () => ({ width: 200, height: 600, data: PIXELS, rect: { x: 300, y: 0, width: 200, height: 600 } });
  const tall = await w.call('browser_save_screenshot', { ref: 'ref_5' });
  assert.match(tall[0].text, /^Saved a screenshot of element ref_5 \(cut to the part inside the viewport\) of t1 \(200x600\)/);
  // one that fits is not
  w.tabs.impl.locate = async () => ({ x: 400, y: 300, w: 200, h: 100 });
  w.tabs.impl.capture = async () => ({ width: 200, height: 100, data: PIXELS, rect: { x: 300, y: 250, width: 200, height: 100 } });
  assert.match(
    (await w.call('browser_save_screenshot', { ref: 'ref_5' }))[0].text,
    /^Saved a screenshot of element ref_5 of t1 \(200x100\)/,
  );
  w.tabs.impl.capture = async () => ({ width: 800, height: 600, data: PIXELS });
  const region = await w.call('browser_save_screenshot', { region: [0, 0, 100, 50] });
  assert.match(region[0].text, /^Saved a screenshot of a region of t1/);
  assert.deepEqual(w.tabs.called('capture').at(-1)[2], { region: [0, 0, 100, 50] });

  const whole = await w.call('browser_save_screenshot', { full_page: true });
  assert.match(whole[0].text, /^Saved a screenshot of the whole page of t1 \(800x2400\)/);
  assert.equal(fs.readFileSync(path.join(root(), SUBFOLDER, `screenshot-mail.test-${idOf(whole)}.jpg`), 'base64'), FULL);
  w.tabs.impl.captureFull = async () => ({ width: 800, height: 8000, data: FULL, truncated: true });
  assert.match((await w.call('browser_save_screenshot', { full_page: true }))[0].text, /of the whole page, cut at 8000 pixels of t1/);

  // the saved screenshot's id attaches it too
  w.tabs.tab.url = 'https://tracker.test/new';
  await w.call('browser_file_upload', { ref: 'ref_2', screenshots: [id] });
  assert.deepEqual(w.tabs.called('setFiles').at(-1)[2], [file]);
  assert.equal(w.asks.length, 3);
});

test('CM-B29b: browser_save_screenshot reads the page through the site gate: a denied or blocked page writes nothing', async () => {
  const w = world();
  // a high-risk page asks before anything reads it, and the user says no; a blocked page refuses at once
  w.tabs.tab.url = 'https://www.chase.com/accounts';
  await assert.rejects(w.call('browser_save_screenshot', {}), code('denied', /^The user did not allow https:\/\/www\.chase\.com\.$/));
  w.tabs.tab.url = 'http://169.254.169.254/';
  await assert.rejects(w.call('browser_save_screenshot', { full_page: true }), code('blocked'));
  assert.deepEqual(w.tabs.called('capture'), []);
  assert.deepEqual(w.tabs.called('captureFull'), []);
  assert.equal(fs.existsSync(path.join(w.uploads, SUBFOLDER)), false);
  // it is a read: a read-only chat may save one (upload still asks)
  const ro = world({ anchor: 'readOnly' });
  const out = await ro.call('browser_save_screenshot', {});
  assert.match(out[0].text, /^Saved a screenshot of the viewport/);
});

test('CM-B30: chrome_* screenshots name an id; upload_image and file_upload attach it under the same confirmation', async () => {
  const w = world({ chrome: true });
  const shot = await w.call('computer', { action: 'screenshot', tabId: 7 });
  const id = idOf(shot);
  // the text names Claude in Chrome's tools, never browser_*
  assert.match(textOf(shot), new RegExp(`Screenshot ID: ${id}\\. To attach it to a file input, give it in file_upload's screenshots\\.`));
  assert.doesNotMatch(textOf(shot), /browser_file_upload/);
  w.tabs.tab.url = 'https://tracker.test/new';
  const out = await w.call('upload_image', { imageId: id, ref: 'ref_3', tabId: 7, filename: 'ignored.png' });
  assert.match(out[0].text, /^Set 1 file on ref_3\./);
  const file = path.join(fs.realpathSync(w.uploads), SUBFOLDER, `screenshot-mail.test-${id}.jpg`);
  assert.deepEqual(w.tabs.called('setFiles'), [[w.tabs.tab, 'ref_3', [file]]]);
  assert.equal(w.asks.length, 1);
  await w.call('file_upload', { ref: 'ref_3', tabId: 7, screenshots: [id] });
  assert.deepEqual(w.tabs.called('setFiles')[1][2], [file]);
  // nothing is dropped on a page: a coordinate without a ref is refused before anything is set
  await assert.rejects(
    w.call('upload_image', { imageId: id, coordinate: [10, 10], tabId: 7 }),
    code('bad_args', /^upload_image needs the file input as ref/),
  );
  await assert.rejects(
    w.call('upload_image', { imageId: 'ss_ffffffff', ref: 'ref_3', tabId: 7 }),
    code('bad_args', /^No screenshot ss_ffffffff/),
  );
  assert.equal(w.tabs.called('setFiles').length, 2);
});

test('CM-B31: every harness sees browser_save_screenshot; a Codex thread on the iab backend is told to save the page and pass the path to setFiles', () => {
  for (const facts of [
    {},
    { nativeChrome: true },
    { nativeComputer: true },
    { drivesUserChrome: true, nativeChrome: true },
    { chromeRelay: true },
  ])
    assert.equal(isToolHidden('browser_save_screenshot', facts), false);
  assert.equal(isToolHidden('browser_save_screenshot', { browserParityOff: true }), true, 'off with the other browser_* tools');
  const hint = screenshotUploadHint('sage');
  assert.match(hint, /browser_save_screenshot of the sage MCP server \(tabId: the plugin tab's providerTabId/);
  assert.match(
    hint,
    /pass the file path it returns to chooser\.setFiles\. A data: URL is not a file: the pane refuses it\. Save it while the tab still shows that page: [^]*a later save captures what the tab shows then\.$/,
  );
  for (const chrome of [true, false]) {
    const note = inAppBrowserNote('sage', chrome, true).value;
    assert.ok(note.includes(hint));
    assert.ok(note.endsWith(UPLOAD_HINT), 'the upload hint still closes the note');
  }
  // with MoPilot's Chrome backend too: said once
  const both = inAppBrowserNote('sage', true, true, null, chromeBackendNote('th-1')).value;
  assert.equal(both.split(hint).length, 2);
  // no iab backend: the browser_* tools' own descriptions say it
  for (const chrome of [true, false]) assert.ok(!inAppBrowserNote('sage', chrome, false).value.includes(hint));
});

test('CM-B31b: the shelf keeps the last screenshots per chat and the most recent chats; ids are random', () => {
  const shelf = new ScreenshotShelf({ perChat: 2, chats: 2 });
  const a1 = shelf.keep('a', { data: '1', mimeType: 'image/jpeg' });
  const a2 = shelf.keep('a', { data: '2', mimeType: 'image/jpeg', url: 'https://x.test/' });
  assert.notEqual(a1, a2);
  assert.match(a1, /^ss_[0-9a-f]{8}$/);
  assert.deepEqual(shelf.get('a', a1), { data: '1', mimeType: 'image/jpeg', url: '' });
  const a3 = shelf.keep('a', { data: '3', mimeType: 'image/jpeg' });
  assert.equal(shelf.get('a', a1), null, 'the oldest of the chat goes');
  assert.equal(shelf.get('a', a3).data, '3');
  shelf.keep('b', { data: 'b', mimeType: 'image/jpeg' });
  // a is used again, so b is the least recent chat when c arrives
  shelf.keep('a', { data: '4', mimeType: 'image/jpeg' });
  shelf.keep('c', { data: 'c', mimeType: 'image/jpeg' });
  assert.equal(shelf.byChat.has('b'), false);
  assert.equal(shelf.get('a', a3).data, '3');
  assert.equal(shelf.get('nobody', a3), null);
  // a shelf given to the tools is the one they use (one per browser in the app)
  const shared = new ScreenshotShelf();
  const w = world({ shelf: shared });
  return w.call('browser_computer', { action: 'screenshot' }).then((out: any[]) => assert.equal(shared.get('c1', idOf(out)).data, PIXELS));
});

test('CM-B31d: the shelf holds at most its byte budget: the least recent chat\u2019s oldest images go first, never the newest', () => {
  const shelf = new ScreenshotShelf({ maxBytes: 10 });
  const a1 = shelf.keep('a', { data: '1234', mimeType: 'image/jpeg' });
  const b1 = shelf.keep('b', { data: '5678', mimeType: 'image/jpeg' });
  const b2 = shelf.keep('b', { data: 'abcd', mimeType: 'image/jpeg' });
  // 12 bytes: chat a (the least recent) gives up its image, and its empty list goes
  assert.equal(shelf.get('a', a1), null);
  assert.equal(shelf.byChat.has('a'), false);
  assert.equal(shelf.bytes, 8);
  // the only chat left gives up its oldest; one image larger than the budget is still kept
  const b3 = shelf.keep('b', { data: 'x'.repeat(20), mimeType: 'image/jpeg' });
  assert.deepEqual([shelf.get('b', b1), shelf.get('b', b2)], [null, null]);
  assert.equal(shelf.get('b', b3).data.length, 20);
  assert.equal(shelf.bytes, 20);
  // the per-chat and chat caps give back their bytes too
  const small = new ScreenshotShelf({ perChat: 1, chats: 1 });
  small.keep('a', { data: '12', mimeType: 'image/jpeg' });
  small.keep('a', { data: '345', mimeType: 'image/jpeg' });
  assert.equal(small.bytes, 3);
  small.keep('b', { data: '6', mimeType: 'image/jpeg' });
  assert.equal(small.bytes, 1);
});

test('CM-B29c: a screenshot of a high-risk site or of a URL with credentials is named without the site', async () => {
  const w = world({ allowSites: true });
  const root = () => fs.realpathSync(w.uploads);
  for (const url of ['https://www.chase.com/accounts', 'https://bob:secret@example.com/page']) {
    w.tabs.tab.url = url;
    const saved = await w.call('browser_save_screenshot', {});
    assert.ok(saved[0].text.includes(`to ${path.join(root(), SUBFOLDER, `screenshot-${idOf(saved)}.jpg`)}.`), url);
    const shot = idOf(await w.call('browser_computer', { action: 'screenshot' }));
    w.tabs.tab.url = 'https://tracker.test/new';
    await w.call('browser_file_upload', { ref: 'ref_1', screenshots: [shot] });
    assert.deepEqual(w.tabs.called('setFiles').at(-1)[2], [path.join(root(), SUBFOLDER, `screenshot-${shot}.jpg`)]);
  }
  // a page with no URL at all (a fresh tab) names none either
  w.tabs.tab.url = '';
  const blank = await w.call('browser_save_screenshot', {});
  assert.match(blank[0].text, new RegExp(`screenshots/screenshot-${idOf(blank)}\\.jpg\\.`));
});

test('CM-B31c: saved file names keep to safe characters and the site; a PNG keeps its extension; a write error is not swallowed', () => {
  assert.equal(safeName('../../etc/passwd'), 'etc-passwd');
  assert.equal(safeName('Invoice #42 (copy).JPEG'), 'Invoice-42-copy-');
  assert.equal(safeName(null), '');
  assert.equal(safeName('x'.repeat(100)).length, 80);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shotwrite-'));
  bases.push(base);
  const png = writeShot(base, { data: Buffer.from('p').toString('base64'), mimeType: 'image/png', url: 'not a url' }, 'ss_1');
  assert.equal(png, path.join(base, SUBFOLDER, 'screenshot-ss_1.png'));
  assert.equal(writeShot(base, { data: 'cA==', mimeType: 'image/png', url: '' }, 'ss_1'), png, 'one file per id');
  // a folder where the file goes: the error reaches the caller
  fs.mkdirSync(path.join(base, SUBFOLDER, 'taken.jpg'));
  fs.chmodSync(path.join(base, SUBFOLDER), 0o500);
  try {
    assert.throws(() => writeShot(base, { data: 'cA==', mimeType: 'image/jpeg', url: '' }, 'ss_2', 'new'), /EACCES|EPERM/);
  } finally {
    fs.chmodSync(path.join(base, SUBFOLDER), 0o700);
  }
});
