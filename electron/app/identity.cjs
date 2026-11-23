// The sign-ins main holds: the Codex accounts and their relay, the MoPilot account, and the identity registry over every harness.
const { Accounts } = require('../identity/codexAccounts.cjs');
const { MoPilotAccount } = require('../identity/mopilot.cjs');
const { Registry: IdentityRegistry } = require('../identity/contract/registry.cjs');
const { CodexDriver } = require('../identity/drivers/codex.cjs');
const { ClaudeDriver } = require('../identity/drivers/claude.cjs');
const { AcpDriver } = require('../identity/drivers/acp.cjs');
const { mergeConsent } = require('../support/telemetry.cjs');
const { updateChannel } = require('../updates/channel.cjs');
const { API_BASE } = require('../platform/install.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { startupResource } = require('./startupResource.cjs');
const { TurnContinuations } = require('../session/turnContinuation.cjs');
const { openMomoAccess, updateMomoAccess } = require('../momo/access.cjs');
const { accountScope } = require('../remote/accountScope.cjs');
const { createConsent } = require('../remote/consent.cjs');
const { openHostAccess, updateHostAccess } = require('../host/access.cjs');
const { openPhoneAccess, updatePhoneAccess, onPhoneAccess } = require('../remote/phoneAccess.cjs');
const path = require('node:path');

/**
 * @param {import('../main.cjs').IdentityDeps} deps what main.cjs passes in; `live` reads main's late-bound services
 */
function createIdentity({
  app,
  shell,
  claude,
  server,
  codexBinary,
  clientInfo,
  codexProviders,
  readState,
  STATE_FILE,
  patchPrefs,
  patchPrefsSync,
  capsChanged,
  reportMigrationOnce,
  updates,
  appWindows,
  live,
}) {
  const { broadcastAll } = appWindows;
  live.remoteConsent = createConsent(live, readState, patchPrefsSync, STATE_FILE);
  /** @type {InstanceType<typeof Accounts>} */
  let accounts;
  /** Providers and account instances over both harnesses (electron/identity). */
  /** @type {InstanceType<typeof IdentityRegistry>} assigned at startup, before any window or IPC handler uses it */
  let identity;
  /** @type {InstanceType<typeof MoPilotAccount>} assigned at startup, before any window or IPC handler uses it */
  let mopilot;
  /** The active key's provider for the next thread, and every added key's, so a thread resumes on its own (#2213). */
  const syncProviders = () =>
    codexProviders
      .sync(accounts?.providerInput() ?? null, accounts?.keyInputs() ?? [])
      .catch((error) => noteIgnored("use the Codex account's own provider", error));
  /** At app ready, once the login shell's env is known: the Codex accounts, their providers and the relay app-server runs on. */
  async function openAccounts(/** @type {AbortSignal} */ signal) {
    let continuations;
    accounts = new Accounts({
      userData: app.getPath('userData'),
      server,
      findBin: codexBinary,
      clientInfo: clientInfo('sage_codex_accounts'),
      // added accounts' sign-ins are kept encrypted (identity/accounts/authVault.cjs)
      safeStorage: require('electron').safeStorage,
      broadcast: (evt) => {
        broadcastAll('accounts:event', evt);
        capsChanged();
        // the next thread/start goes without a provider until the next sync
        syncProviders();
      },
      openExternal: (u) => shell.openExternal(u),
      // the account's key leaves the keychain with it
      forgetProvider: (id) => codexProviders.forget(id),
      // an added key reaches Codex through its thread provider, stored before the account is applied (#2201); decided by
      // this key's own fragment, not by current(), which a newer sync still in flight has not set yet
      provideKey: async (input) => {
        if (!input || !(await codexProviders.fragment(input))) return false;
        await codexProviders.sync(input);
        return true;
      },
      // a chat moved at its usage limit goes on here, once, whether or not a window is open (as Claude's does)
      prepareContinue: (threadId, turnId) => (continuations ??= new TurnContinuations(live.controller, signal)).prepare(threadId, turnId),
      // a chat that ran out but moved too often to move again stays put: say so, as Claude's does
      notifyLimit: (threadId) =>
        live.notifier?.notify('goal', live.controller.chatOf(threadId), {
          title: 'Codex',
          body: 'Usage limit reached · Switch account to continue',
          status: 'usageLimited',
        }),
    });
    // the next thread/start goes without a provider until the next sync
    syncProviders();
    server.threadConfig = (
      await startupResource(
        signal,
        () => accounts.startRelay(),
        () => accounts.dispose(),
      )
    )();
  }
  /** At app ready, after the agent tools: the MoPilot account and the identity registry over every harness. */
  function openMoPilot() {
    /** @type {boolean | null} */
    let wasSignedIn = null;
    /** @type {string | null | undefined} */
    let wasGatewayKey;
    /** @type {string | null} */
    let remoteOwner = null;
    mopilot = new MoPilotAccount({
      userData: app.getPath('userData'),
      // the account's choice merged with this Mac's, stricter side first (D-80)
      onConsent: (account) => {
        const local = readState().prefs?.shareUsageData ?? null;
        const m = mergeConsent(local, account);
        if (m.write) {
          patchPrefs(STATE_FILE(), { shareUsageData: m.value }, []);
          live.telemetry.setConsent(m.value);
          reportMigrationOnce();
          broadcastAll('prefs:changed', { set: { shareUsageData: m.value }, unset: [] });
        }
        if (m.put) mopilot.setConsent(m.value);
      },
      broadcast: (st) => {
        try {
          live.telemetry?.identityChanged?.();
        } catch (error) {
          noteIgnored('retire optional product observations', error);
        }
        // Signing out or replacing the key restarts idle sessions on MoPilot billing; running turns finish (D-74).
        const key = mopilot.gatewayKey();
        const changed = wasSignedIn !== st.signedIn || wasGatewayKey !== key;
        if (wasSignedIn !== null && changed) claude.mopilotChanged();
        if (changed)
          // setMoPilotKey retries applying on the next reconnect
          accounts.setMoPilotKey(key, API_BASE && `${API_BASE}/v1`).catch((error) => noteIgnored('give Codex the MoPilot key', error));
        wasSignedIn = st.signedIn;
        wasGatewayKey = key;
        // the dogfood channel follows whether the account is internal
        if (updates.updater && updates.updater.channel !== updateChannel(updates.updatePrefs.channel, !!st.user?.internal))
          updates.configureUpdates();
        const nextOwner = accountScope(mopilot);
        if (remoteOwner !== nextOwner) {
          remoteOwner = nextOwner;
          try {
            live.remoteConsent.set(false);
          } catch (error) {
            noteIgnored('retire Mobile Remote consent', error);
          }
        }
        // Mobile Remote follows the account (electron/remote/phoneAccess.cjs), decided before the runtime reads it
        updatePhoneAccess(st);
        void live.remote?.sync();
        broadcastAll('mopilot:event', st);
        // MoMo follows the account's invite (electron/momo/access.cjs)
        updateMomoAccess(st);
        // Host follows the account too (electron/host/access.cjs)
        updateHostAccess(st);
      },
    });
    remoteOwner = accountScope(mopilot);
    openMomoAccess({
      file: path.join(app.getPath('userData'), 'momo-access.json'),
      refresh: () => mopilot.refreshStatus(),
      broadcast: (allowed) => broadcastAll('momo:access', allowed),
      // development only: an unpackaged build may stand in for the server's invite
      devInvite: !app.isPackaged && process.env.MOPILOT_MOMO_DEV === '1',
      // the cached kill switch loads after the account (openFlags)
      waitForFlags: true,
    });
    openHostAccess({
      dir: app.getPath('userData'),
      refresh: () => mopilot.refreshStatus(),
      broadcast: (allowed) => broadcastAll('host:access', allowed),
      // development only: an unpackaged build may stand in for the server's invite
      devInvite: !app.isPackaged && process.env.MOPILOT_HOST_DEV === '1',
      waitForFlags: true,
    });
    openPhoneAccess({
      dir: app.getPath('userData'),
      refresh: () => mopilot.refreshStatus(),
      // development only: an unpackaged build may stand in for the server's invite
      devInvite: !app.isPackaged && process.env.MOPILOT_PHONE_DEV === '1',
      waitForFlags: true,
    });
    // sign-in, sign-out or the kill switch starts or stops the runtime and the menu-bar agent with no window open
    onPhoneAccess(() => {
      void live.remote?.sync();
      live.alwaysOn?.sync();
    });
    updateMomoAccess(mopilot.status());
    updateHostAccess(mopilot.status());
    updatePhoneAccess(mopilot.status());
    claude.setGatewayKeyProvider(() => mopilot.gatewayKey());
    claude.setGatewayCapsProvider(() => mopilot.modelCaps());
    identity = new IdentityRegistry();
    identity.register(new CodexDriver(accounts));
    // the marks belong to the Claude sessions, which open after this registry
    identity.register(new ClaudeDriver({ ...claude.identity, marks: () => live.claudeTurns?.marks }));
    identity.register(new AcpDriver({ list: () => live.acpAdmission?.list() ?? [] }));
  }

  return {
    openAccounts,
    openMoPilot,
    get accounts() {
      return accounts;
    },
    get identity() {
      return identity;
    },
    get mopilot() {
      return mopilot;
    },
  };
}

module.exports = { createIdentity };
