// The macOS DMG for first installs, laid out like Granola's: opening it shows one window with the app on the
// left, an arrow drawn on the background (build/dmg, scripts/make-dmg-background.mjs) and an Applications
// shortcut on the right, and nothing else; the app icon is the volume icon. dmgbuild writes the Finder layout
// itself (no Finder scripting, so it works on a headless CI Mac); it is the bundle electron-builder downloads,
// pinned to the same release and SHA-256. scripts/release.mjs signs and notarizes the result.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BACKGROUND = path.join(root, 'build/dmg/background.png');
export const VOLUME_ICON = path.join(root, 'build/icon.icns');

/**
 * Where Finder puts each icon (points; the background is 600 × 400 and leaves these spots clear). The window is
 * 32 points taller than the background: its size includes the title bar.
 */
export const LAYOUT = { window: { width: 600, height: 432 }, iconSize: 128, app: { x: 160, y: 212 }, applications: { x: 440, y: 212 } };

/** dmgbuild's release and checksums, as dmg-builder pins them (node_modules/dmg-builder/out/dmgUtil.js). */
export const DMGBUILD = {
  releaseName: 'dmg-builder@1.2.5',
  checksums: {
    'dmgbuild-bundle-arm64-75c8a6c.tar.gz': '793404d0c96687e27d5ee40a668d498c92e36a64d6c2906df511031adb33cbeb',
    'dmgbuild-bundle-x86_64-75c8a6c.tar.gz': '1664972f9cc2d6e8fce3b63e42cd30078aff602669c5856939c4519921200433',
  },
};

/** The dmgbuild settings (its appdmg-style JSON) for `app` in a volume named `title`. */
export function dmgSettings({ app, title, background = BACKGROUND, icon = VOLUME_ICON }) {
  return {
    title,
    icon,
    // dmgbuild finds background@2x.png beside it and makes one HiDPI image of the pair
    background,
    'icon-size': LAYOUT.iconSize,
    'text-size': 13,
    window: { position: { x: 200, y: 160 }, size: LAYOUT.window },
    // lzfse: smaller and faster to open than zlib, readable on every macOS the app supports (12+)
    format: 'ULFO',
    filesystem: 'HFS+',
    contents: [
      { ...LAYOUT.app, type: 'file', path: app },
      { ...LAYOUT.applications, type: 'link', path: '/Applications' },
    ],
  };
}

/** electron-builder's checked download, loaded when needed: the upload-only release job runs without node_modules. */
async function downloadBuilderToolset(options) {
  const { downloadBuilderToolset: download } = await import('app-builder-lib/out/util/electronGet.js');
  return download(options);
}

/** The dmgbuild executable for this Mac, downloaded once into electron-builder's cache and checked. */
export async function dmgbuildPath({ arch = process.arch, download = downloadBuilderToolset } = {}) {
  const bundle = await download({
    releaseName: DMGBUILD.releaseName,
    filenameWithExt: `dmgbuild-bundle-${arch === 'arm64' ? 'arm64' : 'x86_64'}-75c8a6c.tar.gz`,
    checksums: DMGBUILD.checksums,
  });
  return path.join(bundle, 'dmgbuild');
}

/** Builds `dmg` holding `app` with the dmgbuild at `tool` (see the top of this file). Every other tool is replaceable. */
export function buildDmg(
  { app, dmg, title, tool },
  { exec = execFileSync, mkdtemp = mkdtempSync, writeFile = writeFileSync, rm = rmSync, log = console.log } = {},
) {
  const dir = mkdtemp(path.join(os.tmpdir(), 'mopilot-dmg-'));
  try {
    const settings = path.join(dir, 'settings.json');
    writeFile(settings, JSON.stringify(dmgSettings({ app, title }), null, 2));
    log('$', tool, '-s', settings, title, dmg);
    exec(tool, ['-s', settings, title, dmg], { stdio: 'inherit', env: { ...process.env, PYTHONIOENCODING: 'utf8' } });
  } finally {
    rm(dir, { recursive: true, force: true });
  }
}
