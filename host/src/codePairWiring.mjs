// The Host's pairing by code as the process builds it (R2b of #5576): off unless MOPILOT_HOST_CODE_PAIR=1 (the flag `host.codePair`; the feature is then offered in the hello and the methods are served to the CLI on this machine only). This Host's device key for the proofs of the protocol is made once and kept in the config folder (0600); the run budgets are the data folder's `code-pair.json`; no approval verifier exists yet, so a pairing can be offered and proved but never accepted until the app's native helper makes the person's proof (slice 4).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCrypto } from '../../shared/remote/crypto.mjs';
import { createNodePrimitives } from '../../shared/remote/nodePrimitives.mjs';
import { createApprovalKeys } from './codePairApproval.mjs';
import { createCodePairBudgets } from './codePairBudgets.mjs';
import { createCodePairService } from './codePairService.mjs';
import { createRendezvousClient } from './rendezvousClient.mjs';

/** This Host's Ed25519 device key: read from the config folder, or made and kept there (owner-only). @param {string} configDir @param {ReturnType<typeof createNodePrimitives>} prim */
export function deviceKeyOf(configDir, prim) {
  const file = path.join(configDir, 'code-pair-key.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pk = Buffer.from(saved.pk, 'base64');
    const sk = Buffer.from(saved.sk, 'base64');
    if (pk.length === 32 && sk.length >= 32) return { pk: new Uint8Array(pk), sk: new Uint8Array(sk) };
  } catch {
    // none, or not readable as one: a new one is made (a controller proved by the old one must be paired again)
  }
  const { pk, sk } = prim.edKeypair();
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ pk: Buffer.from(pk).toString('base64'), sk: Buffer.from(sk).toString('base64') }), {
    mode: 0o600,
  });
  return { pk, sk };
}

/** This Host as a device of the protocol: its public key, a name that is safe to show, and the way it signs. @param {string} configDir @param {ReturnType<typeof createNodePrimitives>} prim */
export function deviceOf(configDir, prim) {
  const { pk, sk } = deviceKeyOf(configDir, prim);
  return { pub: pk, name: os.hostname().split('.')[0], sign: (/** @type {Uint8Array} */ message) => prim.edSign(sk, message) };
}

/** The relay link a pairing makes is only created: a host id the other Mac chose that is already enrolled is another client's link and is refused. @param {{ enroll: (p: any, o?: { createOnly?: boolean }) => object }} relayLinks */
export const enrollOnly = (relayLinks) => (/** @type {any} */ params) => relayLinks.enroll(params, { createOnly: true });

/** Whether this Host accepts connections: "Allow connections" is not a setting of this Host yet, so until it is a Host does unless MOPILOT_HOST_ALLOW_CONNECTIONS is 0 (read at each offer). @param {NodeJS.ProcessEnv} env */
export const connectionsOpen = (env) => () => env.MOPILOT_HOST_ALLOW_CONNECTIONS !== '0';

/**
 * @param {object} o
 * @param {NodeJS.ProcessEnv} o.env @param {{ dataDir: string, configDir: string }} o.paths
 * @param {{ enroll: (p: any, o?: { createOnly?: boolean }) => object, forget: (p: { hostId: string }) => unknown, close: () => void }} o.relayLinks
 * @param {Parameters<typeof createCodePairService>[0]['pairing'] & { onForgotten: (fn: (fingerprint: string, kind: string, link: string | undefined) => void) => void, hostId: () => string, controllerRecords: () => number, believeControllers: (fn: (record: any) => boolean) => void }} o.pairing @param {Parameters<typeof createCodePairService>[0]['policy']} o.policy
 * @param {{ note: (e: any) => void }} o.audit @param {(m: string) => void} o.report @param {NodeJS.Platform} [o.platform]
 */
export function codePairFor({ env, paths, relayLinks, pairing, policy, audit, report, platform }) {
  if (env.MOPILOT_HOST_CODE_PAIR !== '1') return undefined;
  const prim = createNodePrimitives();
  const hostId = () => pairing.hostId();
  const keys = createApprovalKeys({
    configDir: paths.configDir,
    hostId,
    controllers: () => pairing.controllerRecords(),
    ...(platform ? { platform } : {}),
  });
  // a controller record written by hand is no controller: it must carry the person's proof, signed by the enrolled key
  pairing.believeControllers((record) => keys.verifyRecord(record));
  const approvals = { status: keys.status, hostId, verify: keys.verify, enrol: keys.enrol };
  const service = createCodePairService({
    relay: createRendezvousClient(),
    crypto: createCrypto(prim),
    device: deviceOf(paths.configDir, prim),
    budgets: createCodePairBudgets({ file: path.join(paths.dataDir, 'code-pair.json') }),
    policy,
    pairing,
    enroll: enrollOnly(relayLinks),
    forget: relayLinks.forget.bind(relayLinks),
    open: connectionsOpen(env),
    approvals,
    audit: audit.note.bind(audit),
    report,
  });
  // a controller that is revoked takes its relay link with it, and a Host that stops ends its offers
  pairing.onForgotten((_fingerprint, kind, link) => {
    if (kind !== 'controller' || !link) return;
    try {
      relayLinks.forget({ hostId: link });
    } catch (error) {
      report(`code pairing: could not forget a relay link: ${error}`);
    }
  });
  const closeLinks = relayLinks.close.bind(relayLinks);
  relayLinks.close = () => {
    service.close();
    closeLinks();
  };
  return service;
}
