// Builds native/disclaim, the launcher that starts agents, shells and ptys outside MoPilot's TCC responsibility.
//   node scripts/build-disclaim.mjs [--out <dir>] [--debug] [--arch arm64|x64]
// Output: native/disclaim/build/disclaim unless --out is given.
// Signing: ad-hoc with the hardened runtime by default; MOPILOT_SIGN_IDENTITY signs it for release
// scripts/package.mjs builds it unsigned (sign: false) and osx-sign signs it inside MoPilot.app.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSwiftProduct, swiftProductCli } from './swift-product.mjs';

export const DISCLAIM_IDENTIFIER = 'ai.mopilot.code.disclaim';
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../native/disclaim');

/** @param {Parameters<typeof buildSwiftProduct>[1]} [o] */
export const buildDisclaim = (o) => buildSwiftProduct({ product: 'disclaim', identifier: DISCLAIM_IDENTIFIER, pkgDir }, o);

/** The command line (see the top of this file); --help prints the usage. */
export function cli(argv, { build = buildDisclaim, log = console.log } = {}) {
  swiftProductCli(argv, 'scripts/build-disclaim.mjs', build, log);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli(process.argv.slice(2));
