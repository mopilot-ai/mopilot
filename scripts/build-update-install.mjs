// Builds the macOS update helper that package.mjs embeds and signs in the app bundle.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSwiftProduct } from './swift-product.mjs';

export const UPDATE_INSTALL_IDENTIFIER = 'ai.mopilot.code.update-install';
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../native/update-install');

/** @param {Parameters<typeof buildSwiftProduct>[1]} [options] */
export const buildUpdateInstall = (options) =>
  buildSwiftProduct({ product: 'update-install', identifier: UPDATE_INSTALL_IDENTIFIER, pkgDir }, options);
