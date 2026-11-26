// The Host's pairing by code as the process builds it (R2b of #5576): off unless MOPILOT_HOST_CODE_PAIR=1 (the flag `host.codePair`; the feature is then offered in the hello and the methods are served to the CLI on this machine only). This Host's device key for the proofs of the protocol is made once and kept in the config folder (0600); the run budgets are the data folder's `code-pair.json`; no approval verifier exists yet, so a pairing can be offered and proved but never accepted until the app's native helper makes the person's proof (slice 4). No code is made unless the app on this Mac said "Allow connections" is on (`connections.json` in the config folder).
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

/**
 * "Allow connections" as the app on this Mac last said it (`host.codePair.connections`), with the fingerprint of that app's own key (the one client off does not keep out), kept in the config folder (0600) and read each time. Closed, and no client exempt, unless the file says so: a Host the app never told, a file that is missing or cannot be read, and an off that could not be written (in this process; the file is removed then if it can be) are all closed.
 * @param {string} configDir
 */
export function connectionsOf(configDir) {
  const file = path.join(configDir, 'connections.json');
  let closedHere = false;
  /** @returns {{ open?: unknown, app?: unknown }} */
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) ?? {};
    } catch {
      return {};
    }
  };
  return {
    open: () => !closedHere && read().open === true,
    /** The fingerprint of this Mac's app's own key, or '' when none was told (no client is exempt then). */
    app() {
      const app = read().app;
      return typeof app === 'string' && /^[0-9a-f]{64}$/.test(app) ? app : '';
    },
    /** @param {boolean} on @param {string} [app] */
    set(on, app = '') {
      // off is off from here on, whatever the write does
      if (!on) closedHere = true;
      const tmp = `${file}.tmp`;
      try {
        fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
        fs.rmSync(tmp, { force: true });
        fs.writeFileSync(tmp, JSON.stringify({ open: on, app }), { mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch (error) {
        try {
          if (!on) fs.rmSync(file, { force: true });
        } catch {
          // the file stays as it was: this process keeps it closed, and the app tells the Host again when it next connects
        }
        throw error;
      }
      if (on) closedHere = false;
    },
  };
}

/**
 * @param {object} o
 * @param {NodeJS.ProcessEnv} o.env @param {{ dataDir: string, configDir: string }} o.paths
 * @param {{ enroll: (p: any, o?: { createOnly?: boolean }) => object, forget: (p: { hostId: string }) => unknown, retire: (p: { hostId: string }) => unknown, retireLive: (p: { hostId: string }) => unknown, onTombstone: (fn: (e: { kind: string, outcome: string }) => void) => void, close: () => void }} o.relayLinks
 * @param {Parameters<typeof createCodePairService>[0]['pairing'] & { onForgotten: (fn: (fingerprint: string, kind: string, link: string | undefined) => void) => void, onRelinked?: (fn: (fingerprint: string, old: string) => void) => void, hostId: () => string, controllerRecords: () => number, believeControllers: (fn: (record: any) => boolean) => void, admitClients: (fn: (who: { fingerprint: string, kind: string }) => boolean) => void, admitChanged: () => void }} o.pairing @param {Parameters<typeof createCodePairService>[0]['policy']} o.policy
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
  const approvals = { status: keys.status, hostId, verify: keys.verify, enrol: keys.enrol, reset: keys.reset };
  const connections = connectionsOf(paths.configDir);
  // "Allow connections" off keeps every client out but this Mac's own app (its key, as the app told it; the CLI never reaches the pairing), desktops added over SSH and controllers included, and keeps their records (on lets them back)
  pairing.admitClients((who) => connections.open() || who.fingerprint === connections.app());
  const service = createCodePairService({
    relay: createRendezvousClient(),
    crypto: createCrypto(prim),
    device: deviceOf(paths.configDir, prim),
    budgets: createCodePairBudgets({ file: path.join(paths.dataDir, 'code-pair.json') }),
    policy,
    pairing,
    enroll: enrollOnly(relayLinks),
    forget: relayLinks.forget.bind(relayLinks),
    retire: relayLinks.retire.bind(relayLinks),
    open: connections.open,
    setOpen: (on, app) => {
      try {
        connections.set(on, app);
      } finally {
        // each live connection is judged again at once, whether or not the switch could be kept
        pairing.admitChanged();
      }
    },
    approvals,
    audit: audit.note.bind(audit),
    report,
  });
  // a controller that is revoked leaves its relay link as a tombstone, which tells the other Mac it was removed (the pair is that Mac's to take off the relay), and a Host that stops ends its offers
  /** @param {string} link */
  const retireLink = (link) => {
    try {
      relayLinks.retire({ hostId: link });
    } catch (error) {
      report(`code pairing: could not retire a relay link: ${error}`);
      // its record is gone already: the link must not stay live, so it refuses in this process (nothing written), on the record as `unsaved`
      relayLinks.retireLive({ hostId: link });
    }
  };
  pairing.onForgotten((_fingerprint, kind, link) => {
    // a link another controller record still names is that one's (a record edited by hand), never retired for this one
    if (kind !== 'controller' || !link || pairing.controllerLinks?.().includes(link)) return;
    retireLink(link);
  });
  // a Mac that paired by code again brought a new link: the one it had is retired, never left open
  pairing.onRelinked?.((_fingerprint, old) => retireLink(old));
  // a tombstone made, and one forgotten (its pair removed by the other Mac, past its time, or the oldest past the most kept), are on the record
  relayLinks.onTombstone((e) => audit.note({ kind: e.kind, by: { kind: 'controller' }, what: { outcome: e.outcome } }));
  const closeLinks = relayLinks.close.bind(relayLinks);
  relayLinks.close = () => {
    service.close();
    closeLinks();
  };
  return service;
}
