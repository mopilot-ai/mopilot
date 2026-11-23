// Builds native/auth-command, the key helper Codex runs as a model provider's auth.command.
//   node scripts/build-auth-command.mjs [--out <dir>] [--debug] [--arch arm64|x64]
// Output: native/auth-command/build/auth-command unless --out is given.
// Signing: ad-hoc with the hardened runtime by default; MOPILOT_SIGN_IDENTITY signs it for release
// scripts/package.mjs builds it unsigned (sign: false) and osx-sign signs it inside MoPilot.app.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSwiftProduct, swiftProductCli } from './swift-product.mjs';

export const AUTH_COMMAND_IDENTIFIER = 'ai.mopilot.code.auth-command';
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../native/auth-command');

/** @param {Parameters<typeof buildSwiftProduct>[1]} [o] */
export const buildAuthCommand = (o) => buildSwiftProduct({ product: 'auth-command', identifier: AUTH_COMMAND_IDENTIFIER, pkgDir }, o);

/** The command line (see the top of this file); --help prints the usage. */
export function cli(argv, { build = buildAuthCommand, log = console.log } = {}) {
  swiftProductCli(argv, 'scripts/build-auth-command.mjs', build, log);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli(process.argv.slice(2));
