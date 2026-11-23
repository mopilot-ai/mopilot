// Fails a signed macOS app that macOS would refuse to run: code claiming a restricted entitlement
// (keychain-access-groups, an application identifier, com.apple.developer.*) that no provisioning profile grants.
// The main executable is SIGKILLed before any of its code runs, and a framework or helper so signed fails to load
// ("code signature invalid"), with nothing on screen either way; 0.3.1 to 0.3.7 shipped like that. Only the main
// executable may claim one, and only with the profile embedded as Contents/embedded.provisionprofile. Every
// Mach-O in the bundle is read, so frameworks, dylibs, .node addons and helpers are covered too.
// scripts/package.mjs and scripts/release.mjs run it.
//   node scripts/check-entitlements.mjs [path/to/MoPilot.app]   (default: out/<productName>-darwin-<arch>/<productName>.app)
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Entitlements only a provisioning profile can grant. */
export const RESTRICTED = /^(keychain-access-groups|com\.apple\.application-identifier|com\.apple\.developer\..+)$/;

/** Mach-O and universal-binary magic numbers, as the first four bytes of a file. */
const MACHO = new Set(['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe']);

/** The restricted entitlement keys in `codesign -d --entitlements - --xml` output. */
export function restrictedKeys(xml) {
  return [...String(xml).matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]).filter((k) => RESTRICTED.test(k));
}

/** Every Mach-O file in the bundle, once: a framework's Versions/Current and top-level links lead to Versions/A. */
export function machOFiles(appPath) {
  const out = [];
  const root = realpathSync(appPath);
  for (const rel of readdirSync(appPath, { recursive: true })) {
    const linked = path.join(appPath, String(rel));
    if (lstatSync(linked).isSymbolicLink()) continue;
    const file = path.join(appPath, path.relative(root, realpathSync(linked)));
    if (file !== linked) continue;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size < 4) continue;
    const head = Buffer.alloc(4);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, head, 0, 4, 0);
    } finally {
      closeSync(fd);
    }
    if (MACHO.has(head.toString('hex'))) out.push(file);
  }
  return out.sort();
}

export function checkEntitlements(appPath, { exec = execFileSync, list = machOFiles, exists = existsSync, log = console.log } = {}) {
  const mainExecutable = path.join(appPath, 'Contents/MacOS', path.basename(appPath, '.app'));
  const profiled = exists(path.join(appPath, 'Contents/embedded.provisionprofile'));
  const wrong = [];
  for (const code of list(appPath)) {
    let xml;
    try {
      xml = exec('codesign', ['-d', '--entitlements', '-', '--xml', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      // name the file and codesign's reason: an unsigned or unreadable binary is otherwise just "Command failed"
      throw new Error(`Could not read the entitlements of ${path.relative(appPath, code)}: ${String(e.stderr || e.message).trim()}`);
    }
    const keys = restrictedKeys(xml);
    if (!keys.length || (code === mainExecutable && profiled)) continue;
    wrong.push(`${path.relative(appPath, code)}: ${keys.join(', ')}`);
  }
  if (wrong.length)
    throw new Error(
      `macOS would refuse to run ${path.basename(appPath)}: restricted entitlements no embedded provisioning profile grants:\n  ${wrong.join('\n  ')}`,
    );
  log('Entitlements OK:', appPath);
}

/** The command line: checks the given app (or this arch's default package). Returns the exit code. */
export function main(argv, { check = checkEntitlements, arch = process.arch, error = console.error } = {}) {
  const { productName } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const app = argv[0] || path.join('out', `${productName}-darwin-${arch}`, `${productName}.app`);
  try {
    check(app);
    return 0;
  } catch (e) {
    error(e.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
