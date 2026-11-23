// Where a browser pane download goes when the system can't name a downloads folder (electron/app/browserDownloads.cjs):
// Windows' known-folder lookup fails for a Downloads folder that isn't there, and the download was cancelled unsaid.
// The fallback is Downloads in the user's home, made only when the home itself is a real folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { browserDownloads } = require('../electron/app/browserDownloads.cjs');
const { DownloadList } = require('../electron/capabilities/browser/downloadList.cjs');

class Item extends EventEmitter {
  savePath = '';
  cancelled = 0;
  getFilename = () => 'Neutral OS.pdf';
  getURL = () => 'https://claude.ai/export.pdf';
  getSavePath = () => this.savePath;
  setSavePath = (p: string) => (this.savePath = p);
  cancel = () => this.cancelled++;
}

/** What Electron does on Windows when FOLDERID_Downloads names a folder that isn't there. */
const noDownloads = () => {
  throw new Error("Failed to get 'downloads' path");
};

function setup(getPath: () => string, home: () => string) {
  const opened: string[] = [];
  const d = browserDownloads({
    app: { getPath },
    session: { fromPartition: () => ({ on: () => undefined }) },
    partition: 'persist:browser',
    tabs: () => null,
    shell: {
      openPath: async (p: string) => {
        opened.push(p);
        return '';
      },
      showItemInFolder: () => undefined,
    },
    broadcast: () => undefined,
    home,
  });
  return { d, opened };
}

function withHome(fn: (home: string) => void | Promise<void>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-home-'));
  return Promise.resolve(fn(home)).finally(() => fs.rmSync(home, { recursive: true, force: true }));
}

test("a download is saved in the home's Downloads, made private, when the system's downloads folder can't be found", () =>
  withHome((home) => {
    const { d } = setup(noDownloads, () => home);
    const item = new Item();
    d.onBrowserDownload({}, item, { id: 3 });
    assert.equal(item.cancelled, 0, 'the download goes on');
    assert.equal(item.savePath, path.join(home, 'Downloads', 'Neutral OS.pdf'));
    const made = fs.statSync(path.join(home, 'Downloads'));
    assert.ok(made.isDirectory());
    // Windows has no POSIX modes to check
    if (process.platform !== 'win32') assert.equal(made.mode & 0o777, 0o700);
    assert.deepEqual(
      d.list.view().downloads.map((r: any) => [r.name, r.pageId]),
      [['Neutral OS.pdf', 3]],
    );
    // a second download uses the folder the first made
    const again = new Item();
    d.onBrowserDownload({}, again, null);
    assert.equal(again.cancelled, 0);
    assert.equal(path.dirname(again.savePath), path.join(home, 'Downloads'));
  }));

test("the system's downloads folder is used when it can be found, and home is neither asked nor touched", () =>
  withHome((home) => {
    let asked = 0;
    const { d } = setup(
      () => '/Users/me/Downloads',
      () => {
        asked++;
        return home;
      },
    );
    const item = new Item();
    d.onBrowserDownload({}, item, null);
    assert.equal(item.savePath, path.join('/Users/me/Downloads', 'Neutral OS.pdf'));
    assert.equal(asked, 0);
    assert.equal(fs.existsSync(path.join(home, 'Downloads')), false);
  }));

test('a home that is gone, relative, empty or not a folder is not rebuilt: the download is cancelled, as before', () =>
  withHome((home) => {
    const file = path.join(home, 'a-file');
    fs.writeFileSync(file, '');
    const cwd = process.cwd();
    for (const bad of [path.join(home, 'moved-profile'), 'relative-home', '', file]) {
      const { d } = setup(noDownloads, () => bad);
      const item = new Item();
      d.onBrowserDownload({}, item, null);
      assert.equal(item.cancelled, 1, JSON.stringify(bad));
      assert.equal(d.list.view().downloads.length, 0);
    }
    assert.equal(fs.existsSync(path.join(home, 'moved-profile')), false, 'a missing home is not made');
    assert.equal(fs.existsSync(path.join(cwd, 'relative-home')), false, 'nothing lands under the working folder');
    assert.equal(fs.existsSync(path.join(cwd, 'Downloads')), false);
  }));

test('a file where the Downloads folder would go cancels the download', () =>
  withHome((home) => {
    fs.writeFileSync(path.join(home, 'Downloads'), '');
    const { d } = setup(noDownloads, () => home);
    const item = new Item();
    d.onBrowserDownload({}, item, null);
    assert.equal(item.cancelled, 1);
    assert.equal(d.list.view().downloads.length, 0);
  }));

test('home is asked only when needed: one that throws does not stop the downloads from being set up, and cancels', () => {
  const broken = () => {
    throw new Error('no home directory');
  };
  // built at startup (electron/app/browserTools.cjs): asking for home here would break registering the browser tools
  const { d } = setup(noDownloads, broken);
  const item = new Item();
  d.onBrowserDownload({}, item, null);
  assert.equal(item.cancelled, 1);
});

test("the Downloads list's Open folder takes the same fallback, and says when there is no folder to open", () =>
  withHome(async (home) => {
    const { d, opened } = setup(noDownloads, () => home);
    assert.deepEqual(await d.list.openFolder(), { ok: true });
    assert.deepEqual(opened, [path.join(home, 'Downloads')]);
    const none = setup(noDownloads, () => path.join(home, 'gone'));
    assert.deepEqual(await none.d.list.openFolder(), {
      ok: false,
      reason: 'open-failed',
      message: `There is no home folder to keep downloads in (${JSON.stringify(path.join(home, 'gone'))}).`,
    });
    assert.deepEqual(none.opened, []);
  }));

test('Open folder says what went wrong when finding the folder throws something that is not an Error', async () => {
  const list = new DownloadList({
    broadcast: () => undefined,
    shell: { openPath: async () => '', showItemInFolder: () => undefined },
    folder: () => {
      throw 'no folder';
    },
  });
  assert.deepEqual(await list.openFolder(), { ok: false, reason: 'open-failed', message: 'no folder' });
});
