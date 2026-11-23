#!/usr/bin/env node
// Builds MoPilot's Chrome extension (design D5, B2 step 2) from electron/chrome-extension into a folder Chrome loads unpacked or the Web Store takes zipped.
//
//   npm run build:chrome-extension               (writes dist/chrome-extension, to load unpacked)
//   npm run build:chrome-extension -- --out <dir>
//   npm run build:chrome-extension -- --store    (writes dist/chrome-extension-store and its zip, to upload)
//
// It checks the manifest before copying: Manifest V3, the permissions the extension is reviewed for and no
// more, the public key that fixes the extension id main allows (EXTENSION_ID in
// electron/capabilities/browser/chromeExtension.cjs), its icons, and every file the manifest and the pages name.
// The unpacked build's version is the app's (package.json), without a prerelease tag, as Chrome takes one to four
// numbers; the full app version is its version_name. The store build has a version of its own (STORE_VERSION), since
// each upload needs a higher one than the last and the app's release version is set elsewhere; it also leaves out the
// key: the Web Store refuses a manifest with one and gives the extension its own id (docs/chrome-web-store/listing.md).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { treeFiles } from './source-tree.mjs';
import { writeZip } from './zip-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
export const SRC = path.join(root, 'electron', 'chrome-extension');
export const OUT = path.join(root, 'dist', 'chrome-extension');
export const STORE_OUT = path.join(root, 'dist', 'chrome-extension-store');
/** What the extension may ask Chrome for: anything else fails the build (a review would ask why). */
export const PERMISSIONS = [
  'alarms',
  'contextMenus',
  'debugger',
  'downloads',
  'nativeMessaging',
  'sidePanel',
  'storage',
  'tabGroups',
  'tabs',
  'webNavigation',
];
/** The icon sizes the Web Store and Chrome's toolbar, menu and extensions page ask for. */
export const ICON_SIZES = ['16', '32', '48', '128'];
const USAGE = 'Usage: node scripts/build-chrome-extension.mjs [--store] [--out <dir>]';

/** The id Chrome gives an extension with this manifest key (the first 128 bits of its SHA-256, in a-p). */
export function extensionIdOf(key) {
  const hex = crypto
    .createHash('sha256')
    .update(Buffer.from(String(key), 'base64'))
    .digest('hex')
    .slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join('');
}

/** The store build's version: bump it once per Web Store upload (0.3.0 was the first, submitted 2026-10-19). */
export const STORE_VERSION = '0.3.6';

/** Chrome's version for an app version: its leading numbers ("0.4.0-dogfood.2" -> "0.4.0"). */
export function chromeVersion(version) {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(version));
  if (!m) throw new Error(`Can't make a Chrome extension version from ${version}`);
  return m
    .slice(1)
    .filter((n) => n !== undefined)
    .join('.');
}

/** The extension's files under `src`, relative and sorted (the manifest, its pages and their modules). */
export function extensionFiles(src = SRC) {
  return treeFiles(src, /\.(?:json|mjs|html|css|png)$/)
    .map((p) => path.relative(src, p).split(path.sep).join('/'))
    .sort();
}

/**
 * Checks the manifest; returns the problems found (none: it builds).
 * @param {any} manifest @param {string} src @param {string} expectedId
 */
export function manifestProblems(manifest, src, expectedId) {
  const problems = [];
  if (manifest?.manifest_version !== 3) problems.push('manifest_version must be 3');
  const perms = [...(manifest?.permissions ?? [])].sort();
  if (JSON.stringify(perms) !== JSON.stringify(PERMISSIONS)) problems.push(`permissions must be exactly ${PERMISSIONS.join(', ')}`);
  if (manifest?.host_permissions?.length)
    problems.push('host_permissions are not needed: chrome.debugger reaches only the tabs the extension attaches');
  if (manifest?.web_accessible_resources?.length) problems.push('no page may be web-accessible: web pages must not open the pairing page');
  if (!manifest?.key || extensionIdOf(manifest.key) !== expectedId) problems.push(`the key must give the extension id ${expectedId}`);
  for (const size of ICON_SIZES) if (!manifest?.icons?.[size]) problems.push(`icons must name a ${size}px PNG`);
  const icons = [...Object.values(manifest?.icons ?? {}), ...Object.values(manifest?.action?.default_icon ?? {})];
  const named = [
    ...new Set(
      [manifest?.background?.service_worker, manifest?.options_page, manifest?.side_panel?.default_path, ...icons].filter(Boolean),
    ),
  ];
  for (const f of named) if (!fs.existsSync(path.join(src, f))) problems.push(`${f} is missing`);
  // what the pages and modules import, load or link must be in the package, not only on disk: a file type the build
  // leaves out (a stylesheet before 0.3.2) would ship a page without it
  const packaged = new Set(extensionFiles(src));
  for (const f of [...packaged].filter((n) => /\.(?:mjs|html)$/.test(n))) {
    const text = fs.readFileSync(path.join(src, f), 'utf8');
    for (const m of text.matchAll(/(?:\bfrom\s*|\bsrc=|\bhref=)['"](?![\w-]+:)([\w./-]+)['"]/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      if (!packaged.has(target))
        problems.push(`${f} loads ${m[1]}, which ${fs.existsSync(path.join(src, target)) ? 'the build leaves out' : 'is missing'}`);
    }
  }
  return problems;
}

/**
 * Copies the extension into `out` with the app's version (the store's, STORE_VERSION, with `store`); throws on a manifest
 * problem. `store`: leave out the key and zip the folder next to it (`<out>-<version>.zip`) for the Web Store.
 * @param {{ src?: string, out?: string, version?: string, expectedId?: string, store?: boolean }} [o]
 * @returns {{ out: string, files: string[], version: string, id: string | null, zip: string | null }}
 */
export function buildExtension({ src = SRC, out: dir = OUT, version, expectedId, store = false } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
  const id = expectedId ?? require('../electron/capabilities/browser/chromeExtension.cjs').EXTENSION_ID;
  const problems = manifestProblems(manifest, src, id);
  if (problems.length) throw new Error(`MoPilot's Chrome extension can't be built:\n- ${problems.join('\n- ')}`);
  const appVersion = String(
    version ?? (store ? STORE_VERSION : JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version),
  );
  const v = chromeVersion(appVersion);
  const { key: _key, ...withoutKey } = manifest;
  const built = { ...(store ? withoutKey : manifest), version: v, ...(appVersion === v ? {} : { version_name: appVersion }) };
  fs.rmSync(dir, { recursive: true, force: true });
  const files = extensionFiles(src);
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    if (f === 'manifest.json') fs.writeFileSync(path.join(dir, f), `${JSON.stringify(built, null, 2)}\n`);
    else fs.copyFileSync(path.join(src, f), path.join(dir, f));
  }
  // the store's id is its own: the dev key's id is not this build's
  if (!store) return { out: dir, files, version: v, id, zip: null };
  const zip = path.join(path.dirname(dir), `${path.basename(dir)}-${v}.zip`);
  writeZip(
    zip,
    files.map((f) => ({ name: f, data: fs.readFileSync(path.join(dir, f)) })),
  );
  return { out: dir, files, version: v, id: null, zip };
}

/** @param {string[]} args @param {{ build?: typeof buildExtension, log?: (s: string) => void }} [o] */
export function cli(args, { build = buildExtension, log = console.log } = {}) {
  if (args.includes('--help')) {
    log(USAGE);
    return;
  }
  const at = args.indexOf('--out');
  const store = args.includes('--store');
  const out = at >= 0 && args[at + 1] ? path.resolve(args[at + 1]) : store ? STORE_OUT : OUT;
  const r = build({ out, store });
  if (r.zip) log(`Built MoPilot's Chrome extension ${r.version} for the Chrome Web Store: upload ${r.zip}.`);
  else log(`Built MoPilot's Chrome extension ${r.version} (id ${r.id}) in ${r.out}: load it unpacked from there.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli(process.argv.slice(2));
