// MoMo's Google source on this Host (S5): the sign-in that finishes here, the sealed account, cursors and clients under MoMo's own folder (so a move carries them with the rest), the read client the notice pipeline uses and the send-only capability only the approval gate is handed. It exists only while this Host is the running home; anything else is "the home is away".
import fs from 'node:fs';
import path from 'node:path';
import { HostRefusal } from './hostFs.mjs';
import { createNodePrimitives } from '../../shared/remote/nodePrimitives.mjs';
import { AccountError, GoogleAccount, revokeGrant } from '../../shared/momoGoogle/account.mjs';
import { GoogleApiError } from '../../shared/momoGoogle/errors.mjs';
import { createGoogleClient, GOOGLE_ENDPOINTS } from '../../shared/momoGoogle/client.mjs';
import { GOOGLE_OAUTH, iosClientConfig, iosRedirect, parseClientConfig } from '../../shared/momoGoogle/clientConfig.mjs';
import { ConsentError, GoogleConsent } from '../../shared/momoGoogle/consent.mjs';
import { createSender, createSendGrants, messageDigest } from '../../shared/momoGoogle/send.mjs';
import { READ_SCOPES } from '../../shared/momoGoogle/types.mjs';
import { createSealer } from '../../shared/momoGoogle/seal.mjs';
import { googleStateOf } from '../../shared/momoGoogle/state.mjs';
import { createAccountFile, createClientsFile, createOwedFile, createVersionStore } from '../../shared/momoGoogle/store.mjs';

/** What a person is told for each way a sign-in or a read can stop; the code is the Host's refusal code. */
/** The longest a wipe waits for Google to say it revoked. */
const WIPE_REVOKE_MS = 3000;
const WORDS = {
  bad_redirect: 'That sign-in did not come back to this app.',
  no_ios_client: 'This machine has no iPhone sign-in set up for Google.',
  superseded: 'That sign-in was cut short because MoMo moved or was reset; start it again.',
  different_account: 'Google is connected to another account. Disconnect it first to connect this one.',
  no_account: 'Connect Google first.',
  unknown_flow: 'That sign-in is not open any more; start it again.',
  expired: 'That sign-in took too long; start it again.',
  invalid: 'That sign-in could not be checked; start it again.',
  denied: 'Google was not allowed.',
  scope_missing: 'Google was connected without all the access MoMo needs.',
  wrong_account: 'That is not the Google account MoMo is connected to.',
  exchange_failed: 'Google did not accept the sign-in.',
  not_connected: 'Google is not connected.',
  needs_sign_in: 'Google needs a new sign-in.',
  unavailable: 'Google could not be reached.',
};

/** How often a revoke that could not be made is tried again, and how many times in one run of the Host (the next start tries again). */
const OWED_EVERY_MS = 15 * 60_000;
const OWED_TRIES = 24;

/** @param {unknown} error */
const refusal = (error) => {
  if (error instanceof HostRefusal) return error;
  if (error instanceof ConsentError || error instanceof AccountError) return new HostRefusal(`google_${error.code}`, WORDS[error.code]);
  if (error instanceof GoogleApiError) return new HostRefusal('google_api', `${error.message}.`);
  // anything else (a file, the seal) is worded here: the raw error is not passed on, whatever it holds
  return new HostRefusal('google_failed', 'Google could not be used on this machine right now.');
};

/** @typedef {ReturnType<typeof createMomoGoogle>} MomoGoogle */
/**
 * @param {object} o
 * @param {ReturnType<typeof import('./momoHome.mjs').createMomoHome>} o.home
 * @param {typeof fetch} [o.fetch]
 * @param {() => number} [o.now]
 * @param {{ gmail: string, calendar: string }} [o.endpoints] where Gmail and Calendar are (a test points them at a fake)
 * @param {string} [o.timeZone] the home's IANA time zone, which says what "the connect day" is (this machine's own by default)
 * @param {{ authUri: string, tokenUri: string, revokeUri: string }} [o.oauth] Google's OAuth endpoints (pinned; only a test passes others)
 * @param {(message: string) => void} [o.report]
 * @param {(ms: number) => Promise<void>} [o.sleep] waits between retries of a call Google was too busy for (a test passes its own)
 * @param {number} [o.revokeMs] how long a revoke at Google is waited for (default 3 seconds)
 * @param {number} [o.wipeRevokeMs] how long a wipe waits for Google to say it revoked
 * @param {number} [o.owedEveryMs] how often a revoke Google could not be asked for is tried again while the Host runs (default 15 minutes, 24 tries a run)
 * @param {boolean} [o.testingMode] the Google project is in Testing mode (refresh tokens end after 7 days), the closed alpha's case
 */
export function createMomoGoogle({
  home,
  fetch: doFetch = globalThis.fetch,
  now = Date.now,
  endpoints = GOOGLE_ENDPOINTS,
  testingMode = true,
  oauth = GOOGLE_OAUTH,
  report = () => undefined,
  sleep,
  wipeRevokeMs = WIPE_REVOKE_MS,
  owedEveryMs = OWED_EVERY_MS,
  revokeMs,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
}) {
  const sealer = createSealer(createNodePrimitives());
  const grants = createSendGrants(now);
  /** @type {{ key: string, dir: string, clientsFile: ReturnType<typeof createClientsFile>, accountFile: ReturnType<typeof createAccountFile>, versions: ReturnType<typeof createVersionStore>, clients: import('../../shared/momoGoogle/store.mjs').Clients | null, account: GoogleAccount | null, consent: GoogleConsent | null } | null} */
  let built = null;
  let gateTaken = false;

  /** `parts` calls take turns, so two at once (a status and a reader at startup) never build two accounts over the same file. */
  let building = Promise.resolve();
  /** What this home holds for Google, made once per lease and rebuilt when the clients change. */
  async function parts() {
    const before = building;
    let release;
    building = new Promise((resolve) => {
      release = resolve;
    });
    await before;
    try {
      return await buildParts();
    } finally {
      release();
    }
  }
  async function buildParts() {
    const stamp = home.stamp();
    if (!stamp) {
      // this Host is not the running home (moved away, reset, revoked): what was built for it never acts again
      drop();
      throw new HostRefusal('momo_home_away', "MoMo's home is not running on this machine.");
    }
    const key = `${stamp.homeId}:${stamp.leaseEpoch}`;
    if (built?.key === key) return built;
    // a new lease: the old account object never refreshes or saves again, wherever it was handed (an old reader)
    drop();
    const dir = path.join(home.storage.dir, 'google');
    const safe = home.data.safeStorage;
    const clientsFile = createClientsFile(dir, safe, fs.promises);
    const clients = await clientsFile.load();
    const accountFile = createAccountFile(dir, safe, fs.promises);
    const account = clients
      ? new GoogleAccount({
          file: accountFile,
          config: clients.desktop,
          iosConfig: clients.ios,
          fetch: doFetch,
          now,
          testingMode,
          ...(revokeMs ? { revokeMs } : {}),
        })
      : null;
    const consent =
      account && clients
        ? new GoogleConsent({ account, config: clients.desktop, iosConfig: clients.ios, sealer, fetch: doFetch, now })
        : null;
    const versions = createVersionStore(dir, safe, fs.promises, {
      report: (e) => report(`MoMo's Google cursors could not be saved: ${/** @type {Error} */ (e).message}`),
    });
    return (built = { key, dir, clientsFile, accountFile, versions, clients, account, consent });
  }

  /** Lets go of what was built: its account never saves again and its cursors are not written (a pause flushes them first). */
  function drop() {
    built?.account?.dispose();
    built?.versions.discard();
    built = null;
  }

  /** A part that needs the Google clients; a home without them cannot sign in. @template T @param {T | null} part */
  const needClients = (part) => {
    if (!part) throw new HostRefusal('google_not_configured', 'This machine has no Google client set up yet.');
    return part;
  };

  /** The revokes owed: the Host's own sealed file (a Reset keeps it, so a grant that could not be revoked before a Reset is still tried after). */
  const owedFile = () => createOwedFile(home.hostOnlyStorage.dir, home.hostOnlyStorage.safeStorage, fs.promises);
  /** @param {string} token a refresh token Google could not be asked to revoke */
  async function owe(token) {
    try {
      const file = owedFile();
      await file.save([...(await file.load()), { token, at: now() }]);
    } catch (e) {
      report(`MoMo could not keep a Google revoke to try again: ${/** @type {Error} */ (e).message}`);
    }
  }
  /** Tries every owed revoke once; the ones Google says yes to are forgotten. */
  async function settleOwed() {
    try {
      const file = owedFile();
      const owed = await file.load();
      if (!owed.length) return;
      const left = [];
      for (const o of owed)
        if (!(await revokeGrant({ fetch: doFetch, revokeUri: oauth.revokeUri, token: o.token, ms: wipeRevokeMs }))) left.push(o);
      if (left.length !== owed.length) await file.save(left);
    } catch (e) {
      report(`MoMo could not settle a Google revoke: ${/** @type {Error} */ (e).message}`);
    }
  }
  /** @type {ReturnType<typeof setInterval> | null} */
  let owedTimer = null;

  const service = {
    /** The Host starts: an owed revoke is tried now and then every 15 minutes (24 times a run), so a grant Google could not be asked about is not forgotten. */
    start() {
      void settleOwed();
      let tries = 0;
      owedTimer ??= setInterval(() => {
        if (++tries > OWED_TRIES) {
          if (owedTimer) clearInterval(owedTimer);
          owedTimer = null;
          return;
        }
        void settleOwed();
      }, owedEveryMs);
      owedTimer.unref();
    },
    /** Tries the owed revokes now (the Host's start and its timer call it). */
    settleOwed,
    /** The home pauses (a move begins, MoMo is reset): the cursors are written, then what is only in memory (open sign-ins, the built clients) is dropped. */
    async pause() {
      await built?.versions.flush();
      drop();
    },
    /**
     * MoMo's Google data is about to be deleted. Unless the data is moving (the account goes on at the new home), the grant is revoked at Google
     * first: best effort, a few seconds at most, never holding the wipe up on the network.
     */
    async wipe() {
      // from the sealed files, not from what is built: a pause just before (as in Reset) has dropped what was built, and the grant must still be revoked
      if (home.record()?.state !== 'moving') {
        const dir = path.join(home.storage.dir, 'google');
        const accountFile = createAccountFile(dir, home.data.safeStorage, fs.promises);
        const kept = await accountFile
          .load()
          .catch((e) => (report(`MoMo's Google account could not be read to revoke it: ${e.message}`), null));
        if (kept) {
          const revoked = await revokeGrant({
            fetch: doFetch,
            revokeUri: oauth.revokeUri,
            token: kept.tokens.refreshToken,
            ms: wipeRevokeMs,
          });
          if (!revoked) await owe(kept.tokens.refreshToken);
          await accountFile.clear();
        }
      }
      drop();
    },
    /** The redirect the phone's sign-in session returns to, when the home holds an iOS client (it is not a secret: the app needs it to open the sign-in); null otherwise. */
    async iosRedirect() {
      const p = await parts();
      return { uri: p.clients?.ios ? iosRedirect(p.clients.ios.clientId) : null };
    },
    /** The typed state of the source (shared/momoGoogle/state.mjs). */
    async status() {
      const p = await parts();
      if (!p.account || !p.consent || !p.clients)
        return googleStateOf({ status: { state: 'not_connected' }, pending: 0, configured: { desktop: false, iosRedirectUri: null } });
      return googleStateOf({
        status: await p.account.status(),
        pending: p.consent.pending(),
        configured: { desktop: true, iosRedirectUri: p.clients.ios ? iosRedirect(p.clients.ios.clientId) : null },
      });
    },
    /**
     * The Mac (which holds the downloaded client file) hands the home its Google clients; they are sealed here and move with the home.
     * @param {{ desktopJson: string, iosClientId?: string }} p
     */
    async configure({ desktopJson, iosClientId }) {
      const p = await parts();
      // the clients are what a refresh and a sign-in send the tokens through: not changed under a connected account
      if (await p.accountFile.load()) throw new HostRefusal('google_connected', 'Disconnect Google before changing its client.');
      let clients;
      try {
        clients = { desktop: parseClientConfig(desktopJson, oauth), ...(iosClientId ? { ios: iosClientConfig(iosClientId, oauth) } : {}) };
      } catch (e) {
        throw new HostRefusal('google_bad_client', /** @type {Error} */ (e).message);
      }
      await p.clientsFile.save(clients);
      drop();
      return service.status();
    },
    /** @param {{ purpose: 'read' | 'send', client: 'desktop' | 'ios', redirectUri: string }} p */
    async begin(p) {
      const { consent } = await parts();
      return needClients(consent).begin(p);
    },
    /** @param {{ flowId: string, sealed: string }} p */
    async complete({ flowId, sealed }) {
      const { consent } = await parts();
      await needClients(consent).complete(flowId, sealed);
      return service.status();
    },
    /** Revokes at Google, erases the tokens and the cursors, keeps the clients. */
    async disconnect() {
      const { account, versions } = await parts();
      // the cursors go first and locally; the revoke at Google is bounded and last
      await versions.clear();
      const { revoked, owedToken } = await needClients(account).disconnect();
      // Google could not say the grant is gone: its token is still live, so it is kept owed (and tried again) instead of forgotten
      if (owedToken) await owe(owedToken);
      return { revoked, owed: !!owedToken, state: await service.status() };
    },
    /** What the notice pipeline reads with: the Gmail/Calendar client and the durable cursors; a read that needs a new sign-in throws `google_needs_sign_in`. */
    async reader() {
      const p = await parts();
      const account = needClients(p.account);
      const client = createGoogleClient({ account, now, endpoints, timeZone, ...(sleep ? { sleep } : {}) });
      /** @param {() => Promise<any>} run */
      const guarded = async (run) => {
        try {
          return await run();
        } catch (e) {
          throw refusal(e);
        }
      };
      return {
        client: {
          listThreads: (/** @type {any} */ q) => guarded(() => client.listThreads(q)),
          getThreadMeta: (/** @type {string} */ id) => guarded(() => client.getThreadMeta(id)),
          listEvents: (/** @type {any} */ q) => guarded(() => client.listEvents(q)),
          calendarEtag: () => guarded(() => client.calendarEtag()),
          getMail: (/** @type {string} */ id) => guarded(() => client.getMail(id)),
        },
        versions: p.versions,
      };
    },
    /**
     * The send-only capability, handed out once and only to the approval gate: `mint` makes a single-use grant for one message and
     * `send` spends it. Nothing else on this object can send, and a second take is refused.
     */
    takeSendForGate() {
      if (gateTaken) throw new HostRefusal('google_send_taken', 'The send capability was already handed to the approval gate.');
      gateTaken = true;
      return {
        mint: grants.mint,
        digest: messageDigest,
        canSend: async () => {
          const p = await parts();
          return !!p.account && createSender({ account: p.account, redeem: grants.redeem, endpoint: endpoints.gmail }).canSend();
        },
        /** @param {import('../../shared/momoGoogle/send.mjs').OutgoingMessage} message @param {string | undefined} grant */
        async send(message, grant) {
          const p = await parts();
          if (!p.account) return /** @type {const} */ ({ ok: false, reason: 'not_granted' });
          return createSender({ account: p.account, redeem: grants.redeem, endpoint: endpoints.gmail }).send(message, grant);
        },
      };
    },
    /**
     * One record in each file this keeps (the clients, the account, the cursors), written the way a real sign-in writes them, for a check that
     * everything MoMo keeps opens after a move, and only where MoMo keeps nothing of Google yet. A connected look, never a usable grant: its tokens are placeholders no Google has seen.
     */
    async seed() {
      // never over something real: with any of the three files already there nothing is written
      const held = await parts();
      if (held.clients || (await held.accountFile.load()) || fs.existsSync(path.join(held.dir, 'google-versions.sealed'))) return;
      const desktopJson = JSON.stringify({
        installed: {
          client_id: 'seed-client.apps.googleusercontent.com',
          client_secret: 'seed-secret',
          auth_uri: oauth.authUri,
          token_uri: oauth.tokenUri,
        },
      });
      await service.configure({ desktopJson });
      const p = await parts();
      const at = now();
      await p.accountFile.save({
        version: 1,
        email: 'seed@example.com',
        subject: 'seed-subject',
        connectedAt: at,
        grantedAt: at,
        tokens: { accessToken: 'seed-access', refreshToken: 'seed-refresh', expiresAt: at + 3_600_000, scopes: [...READ_SCOPES] },
      });
      await p.versions.set('gmail:seed', 'v1');
      await p.versions.flush();
      drop();
    },
  };
  // every step a client can reach says only what `refusal` words: a raw error (a file, the seal, the network) never leaves with its text
  for (const name of /** @type {const} */ (['status', 'iosRedirect', 'configure', 'begin', 'complete', 'disconnect', 'reader'])) {
    const run = /** @type {(p?: any) => Promise<any>} */ (service[name]);
    /** @type {any} */ (service)[name] = async (/** @type {any} */ p) => {
      try {
        return await run.call(service, p);
      } catch (e) {
        throw refusal(e);
      }
    };
  }
  return service;
}
