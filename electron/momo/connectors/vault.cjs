// MoMo's connector token vault (#2999 C0): the gateway's sealed token vault (gateway/vault.cjs) kept under MoMo's folder, <momo dir>/connectors/tokens.json, so Reset MoMo erases it (store 'connectors').
const path = require('node:path');
const { TokenVault: SealedTokenVault, CONNECTOR_ID, LEVELS } = require('../../gateway/vault.cjs');

/**
 * @typedef {import('../../gateway/vault.cjs').Level} Level
 * @typedef {import('../../gateway/vault.cjs').TokenSet} TokenSet
 * @typedef {import('../../gateway/vault.cjs').Tokens} Tokens
 */

class TokenVault extends SealedTokenVault {
  /**
   * @param {{ dir: string, safeStorage: import('../../gateway/sealedFile.cjs').SafeStorage | null | undefined, now?: () => number }} o
   *   dir: MoMo's folder; the vault keeps <dir>/connectors/tokens.json
   */
  constructor({ dir, safeStorage, now }) {
    super({ file: path.join(dir, 'connectors', 'tokens.json'), safeStorage, now });
  }
}

module.exports = { TokenVault, CONNECTOR_ID, LEVELS };
