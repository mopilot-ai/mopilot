// A stand-in for Electron's safeStorage in Host tests: reversible, so a test can open what was sealed, and never plain text on disk (electron/host/pairingClient.cjs seals this app's Host key with it).
import fs from 'node:fs';
import { createRequire } from 'node:module';

export const keySafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`sealed:${Buffer.from(s).toString('base64')}`),
  decryptString: (b: Buffer) => {
    const t = b.toString();
    if (!t.startsWith('sealed:')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
    return Buffer.from(t.slice('sealed:'.length), 'base64').toString();
  },
};

/** What a sealed Host key file holds, opened with keySafe. @param {string} file */
export const openKeyFile = (file: string) =>
  JSON.parse(keySafe.decryptString(Buffer.from(JSON.parse(fs.readFileSync(file, 'utf8')).data, 'base64')));

const require = createRequire(import.meta.url);
const machines = require('../../electron/host/machines.cjs');
/** machines.cjs's service as main makes it, with the test keychain where main passes Electron's. */
export const createMachines = (o: any) => machines.createMachines({ safeStorage: keySafe, ...o });
export const { requestOverSocket } = machines;
