// The Host tarball the packaged app uploads must be the one this checkout builds: the packager's ignore list and
// prune sit between the checkout and app.asar, and a file they drop makes the app's Host install fail on the first
// user's machine (electron/host/bundle.cjs reads app.asar through Electron's fs shim at run time).
// package.mjs runs this on the pruned app folder, before it becomes app.asar.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { buildBundle, hostFiles } = require('../electron/host/bundle.cjs');
const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** What the packager rewrites in the app folder (afterCopy stamps a release build, packager writes the app version): the Host reads these as the app it ships with, so they may differ from the checkout's. */
const REWRITTEN = new Set(['package.json']);

/** The first of `paths` whose bytes differ between the two trees. @param {string[]} paths @param {string} a @param {string} b */
const firstDifference = (paths, a, b) =>
  paths.find((p) => !REWRITTEN.has(p) && !readFileSync(path.join(a, p)).equals(readFileSync(path.join(b, p))));

/**
 * Build the Host archive from the staged app folder; throw unless it has the same files and bytes as the one `sourceRoot` builds.
 * @param {string} appDir the packager's pruned app folder
 * @param {string} [sourceRoot] the checkout the build runs from
 * @returns {string} the archive's SHA-256, which an install of the packaged app uploads
 */
export function checkHostBundle(appDir, sourceRoot = ROOT) {
  const out = mkdtempSync(path.join(os.tmpdir(), 'mopilot-host-check-'));
  try {
    const source = hostFiles(sourceRoot);
    const packaged = hostFiles(appDir);
    const gaps = [
      ...source.filter((p) => !packaged.includes(p)).map((p) => `${p} is missing`),
      ...packaged.filter((p) => !source.includes(p)).map((p) => `${p} is extra`),
    ];
    if (gaps.length) throw new Error(`The packaged app would build a different Host archive: ${gaps.join(', ')}.`);
    // the archive is a pure function of these paths and bytes (bundle.cjs), so equal files are equal checksums
    const differs = firstDifference(source, sourceRoot, appDir);
    if (differs) throw new Error(`The packaged app would build a different Host archive: ${differs} differs.`);
    return buildBundle({ root: appDir, outDir: out }).sha256;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
