// Refuses to install a phone build that was not made from the tree it was asked for: reads the commit the app's config carries and compares it with the tree's own.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { treeCommit } = require('../mobile/config/commit.js');

/** The commit stamped into a built .app (its EXConstants app.config), or undefined. @param {string} appPath */
export function builtCommit(appPath) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(appPath, 'EXConstants.bundle', 'app.config'), 'utf8'));
    return typeof config?.extra?.buildCommit === 'string' ? config.extra.buildCommit : undefined;
  } catch {
    return undefined;
  }
}

/** @param {string} appPath @param {string} treeDir @returns {{ ok: true, commit: string } | { ok: false, reason: string }} */
export function checkBuild(appPath, treeDir) {
  const built = builtCommit(appPath);
  const wanted = treeCommit(treeDir);
  if (!wanted) return { ok: false, reason: `${treeDir} is not a git tree, so what the build holds cannot be checked` };
  if (!built) return { ok: false, reason: `${appPath} carries no build commit: it was not built by this config` };
  if (built !== wanted) return { ok: false, reason: `${appPath} was built from ${built}, not from ${wanted} (${treeDir})` };
  return { ok: true, commit: built };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [appPath, treeDir] = process.argv.slice(2);
  if (!appPath || !treeDir) {
    console.error('usage: mobile-ios-commit.mjs <built .app> <tree the build was asked for>');
    process.exit(2);
  }
  const result = checkBuild(appPath, treeDir);
  if (!result.ok) {
    console.error(`refusing to install: ${result.reason}`);
    process.exit(1);
  }
  console.log(`build commit ${result.commit} matches the tree`);
}
