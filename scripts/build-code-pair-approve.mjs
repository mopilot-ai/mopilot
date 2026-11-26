// Builds native/code-pair-approve, the helper that makes the person's proof for pairing by code (Remote Run, #5576).
//   node scripts/build-code-pair-approve.mjs [--out <dir>] [--debug] [--arch arm64|x64]
// Output: native/code-pair-approve/build/code-pair-approve unless --out is given.
// Signing: ad-hoc with the hardened runtime by default; MOPILOT_SIGN_IDENTITY signs it for release.
// scripts/package.mjs builds it unsigned (sign: false) and osx-sign signs it inside MoPilot.app.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSwiftProduct, swiftProductCli } from './swift-product.mjs';

export const CODE_PAIR_APPROVE_IDENTIFIER = 'ai.mopilot.code.code-pair-approve';
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../native/code-pair-approve');

/** @param {Parameters<typeof buildSwiftProduct>[1]} [o] */
export const buildCodePairApprove = (o) =>
  buildSwiftProduct({ product: 'code-pair-approve', identifier: CODE_PAIR_APPROVE_IDENTIFIER, pkgDir }, o);

/** The command line (see the top of this file); --help prints the usage. @param {string[]} argv */
export function cli(argv, { build = buildCodePairApprove, log = console.log } = {}) {
  swiftProductCli(argv, 'scripts/build-code-pair-approve.mjs', build, log);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli(process.argv.slice(2));
