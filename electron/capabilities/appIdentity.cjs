// What every computer-use surface shows for an app an agent names (a bundle id like "com.apple.TextEdit" or a name like "Notes"): its display name, bundle id and icon, read from the installed app (Spotlight for a bundle id, the Applications folders for a name, then its Info.plist), cached per query.

const { fs } = require('../platform/ports/fs.cjs');
const os = require('node:os');
const path = require('node:path');
const { proc } = require('../platform/ports/proc.cjs');

const APP_DIRS = ['/Applications', '/System/Applications', '/System/Applications/Utilities', '/Applications/Utilities'];
const BUNDLE_ID = /^[A-Za-z][\w-]*(\.[\w-]+)+$/;

/**
 * Runs a command and gives its stdout ('' on any failure: a lookup that fails names nothing).
 * @param {string} file
 * @param {string[]} args
 * @returns {Promise<string>}
 */
function run(file, args) {
  return new Promise((resolve) => proc.execFile(file, args, { timeout: 3000 }, (err, out) => resolve(err ? '' : String(out))));
}

/** Whether `app` reads as a bundle id ("com.apple.TextEdit"), not a name ("Notes.app" is a name). */
function isBundleId(app) {
  return BUNDLE_ID.test(app) && !/\.app$/i.test(app);
}

class AppIdentity {
  /**
   * @param {object} [o]
   * @param {(file: string, args: string[]) => Promise<string>} [o.run]
   * @param {(file: string) => boolean} [o.exists]
   * @param {{ createThumbnailFromPath(file: string, size: { width: number, height: number }): Promise<{ toDataURL(): string, isEmpty(): boolean }> } | null} [o.images] Electron's nativeImage, for icons
   * @param {string} [o.home]
   */
  constructor(o = {}) {
    this.run = o.run || run;
    this.exists = o.exists || fs.existsSync;
    this.images = o.images ?? null;
    this.home = o.home ?? os.homedir();
    /** lower-cased query -> Promise<{name, bundleId, icon} | null> */
    this.cache = new Map();
  }

  /** Where an app named like this is installed, or null. */
  pathOfName(name) {
    const base = path.basename(String(name)).replace(/\.app$/i, '');
    for (const dir of [...APP_DIRS, path.join(this.home, 'Applications')]) {
      const p = path.join(dir, `${base}.app`);
      if (this.exists(p)) return p;
    }
    return null;
  }

  /**
   * Where the app with this bundle id is installed: Spotlight (the Applications folders first), else
   * LaunchServices for a running app (Spotlight can be off), or null.
   */
  async pathOfBundle(bundleId) {
    const id = bundleId.replace(/["\\]/g, '');
    const out = await this.run('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == "${id}"`]);
    const paths = out.split('\n').filter((p) => p.endsWith('.app'));
    const found = paths.find((p) => APP_DIRS.some((d) => p.startsWith(`${d}/`))) ?? paths[0];
    if (found) return found;
    const running = await this.run('/usr/bin/lsappinfo', ['info', '-only', 'bundlepath', '-app', id]);
    return /path="([^"]+\.app)"/.exec(running)?.[1] ?? null;
  }

  /** The app's name and bundle id from its Info.plist (the folder name when it has none). */
  async info(appPath) {
    const plist = await this.run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')]);
    let p = {};
    try {
      p = JSON.parse(plist);
    } catch {
      p = {};
    }
    const named = [p.CFBundleDisplayName, p.CFBundleName].find((x) => typeof x === 'string' && x.trim());
    return {
      name: named ? named.trim() : path.basename(appPath, '.app'),
      bundleId: typeof p.CFBundleIdentifier === 'string' ? p.CFBundleIdentifier : null,
    };
  }

  /** The app's own icon as a data: URL (QuickLook: app.getFileIcon gives a generic one for a bundle), or null. */
  async icon(appPath) {
    if (!this.images?.createThumbnailFromPath) return null;
    try {
      const img = await this.images.createThumbnailFromPath(appPath, { width: 64, height: 64 });
      return img.isEmpty() ? null : img.toDataURL();
    } catch {
      return null;
    }
  }

  /**
   * {name, bundleId, icon} for an app an agent named, or null when no installed app matches (the caller
   * keeps its own fallback). Asked once per query: later calls share the answer.
   * @param {unknown} app
   */
  resolve(app) {
    if (typeof app !== 'string' || !app.trim()) return Promise.resolve(null);
    const q = app.trim();
    const key = q.toLowerCase();
    const known = this.cache.get(key);
    if (known) return known;
    const found = (async () => {
      const where = isBundleId(q) ? await this.pathOfBundle(q) : this.pathOfName(q);
      if (!where) return null;
      const [info, icon] = await Promise.all([this.info(where), this.icon(where)]);
      return { name: info.name, bundleId: info.bundleId ?? (isBundleId(q) ? q : null), icon };
    })();
    this.cache.set(key, found);
    return found;
  }

  /** What the control pill shows for `app`: its name and icon; no name when no app is known yet. */
  async shown(app) {
    if (typeof app !== 'string' || !app.trim()) return { name: null, icon: null };
    const r = await this.resolve(app);
    return { name: r?.name ?? (isBundleId(app.trim()) ? 'App' : app.trim()), icon: r?.icon ?? null };
  }

  /** What a notification calls `app`: a name as it is, a bundle id (Codex Computer Use) once resolved, else "an app". */
  label(app) {
    return isBundleId(app) ? this.resolve(app).then((r) => r?.name ?? 'an app') : app;
  }
}

module.exports = { AppIdentity, isBundleId, run };
