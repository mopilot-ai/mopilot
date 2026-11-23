// What the Host's update tests share (host/src/update.mjs, shared/host/updateSignature.mjs): a publisher's key, a Host's name, and manifests signed the way the app signs them for one Host.
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createPairing } from '../../host/src/pairing.mjs';
// @ts-ignore: plain ESM without declarations
import { createPaths } from '../../host/src/paths.mjs';
import { signManifest } from '../../shared/host/updateSignature.mjs';

export const pemPair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
};
/** The key the tests' app signs with, and the name of the Host they sign for. */
export const KEYS = pemPair();
export const HOST_ID = 'abababababababababababababababab';
/** What `stageUpdate` is given to trust the tests' app. */
export const TRUST = { keys: [KEYS.pub], hostId: HOST_ID, coreLoads: () => '' };

let seq = Date.now();
/** The facts of a manifest, signed: for `hostId`, one build after the last this kit made, good for an hour. */
export function signedFacts(
  facts: { version: string; sha256: string; url: string },
  o: { hostId?: string; seq?: number; notAfter?: number; key?: string; now?: number } = {},
) {
  const full = {
    ...facts,
    hostId: o.hostId ?? HOST_ID,
    seq: o.seq ?? ++seq,
    notAfter: o.notAfter ?? (o.now ?? Date.now()) + 60 * 60 * 1000,
  };
  return { ...full, signature: signManifest(full, o.key ?? KEYS.priv) };
}

/** Makes a data dir's Host trust the tests' app: the update key in its config dir. Answers the Host's name, which a manifest for it must carry. @param {string} dataDir */
export function trustDataDir(dataDir: string): string {
  const paths = createPaths({ dataDir, env: {} });
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.writeFileSync(path.join(paths.configDir, 'update-key.pub'), KEYS.pub);
  return createPairing({ configDir: paths.configDir }).hostId();
}
