// Phone account refresh: rotate once per account and reject completions owned by a retired sign-in.
/** @param {{ vault: any, refresh: (token: string, operation: string) => Promise<any>, revoke?: (refreshToken: string) => Promise<boolean | void>, relayToken?: (accessToken: string) => Promise<any>, now?: () => number }} o `revoke` ends the device's session at the account service on sign-out (which also removes its pairs at the relay and tells the computers); `relayToken` asks the account service for the token the relay accepts (the access token itself never goes to the relay) */
export function createPhoneAuth(o) {
  let generation = 0;
  /** @type {{ user: { id: string }, deviceId: string, refreshToken: string, accessToken?: string, expiresAt?: number } | null} */
  let current = null;
  /** @type {Promise<string> | null} */
  let inflight = null;
  /** @type {{ owner: number, token: string, exp: number } | null} the relay's token for this sign-in; it lives in memory only */
  let relay = null;
  /** @type {Promise<string> | null} */
  let relaying = null;
  let writes = Promise.resolve();
  const write = (fn) => {
    const next = writes.then(fn);
    writes = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const now = o.now ?? Date.now;
  const auth = {
    expiresAt: () => current?.expiresAt ?? 0,
    /** When the relay token in hand ends (0 when there is none). */
    relayExpiresAt: () => relay?.exp ?? 0,
    async restore() {
      const owner = ++generation;
      relay = relaying = null;
      const account = await o.vault.getAccount();
      if (owner !== generation) throw new Error('account changed');
      current = account;
      // a relay token made while this restore was reading the vault belongs to the account that was there before
      relay = relaying = null;
      return account;
    },
    async install(account) {
      const owner = ++generation;
      current = null;
      inflight = relay = relaying = null;
      await write(async () => {
        if (owner !== generation) throw new Error('account changed');
        await o.vault.setAccount(account);
      });
      if (owner !== generation) throw new Error('account changed');
      current = account;
    },
    async signOut() {
      const owner = ++generation;
      // The phone is wiped first: signing out must finish even if the app is suspended or killed meanwhile. The refresh token it held is
      // then ended at the account service (which also removes this phone's pairs at the relay and tells the Macs), so a copy made earlier
      // (a backup, a lost phone's image) stops working. The outcome is returned for the caller to show; it never fails the sign-out.
      let leaving = current;
      try {
        leaving ??= await o.vault.getAccount();
      } catch {
        leaving = null;
      }
      current = null;
      inflight = relay = relaying = null;
      await write(async () => {
        if (owner === generation) await o.vault.setAccount(null);
      });
      let revoked = false;
      if (leaving?.refreshToken && o.revoke) {
        try {
          revoked = (await o.revoke(leaving.refreshToken)) !== false;
        } catch {
          revoked = false;
        }
      }
      return { revoked };
    },
    async token(force = false) {
      if (!current) throw new Error('sign in required');
      if (!force && current.accessToken && (current.expiresAt ?? 0) > now() + 60000) {
        const account = current,
          owner = generation;
        const stored = await o.vault.getAccount();
        if (owner !== generation || !stored || stored.deviceId !== account.deviceId || stored.refreshToken !== account.refreshToken)
          throw new Error('account changed');
        return account.accessToken;
      }
      if (inflight) return inflight;
      const account = current,
        owner = generation;
      const pending = (async () => {
        const claim = await o.vault.claimRefresh(account.refreshToken);
        if (owner !== generation) throw new Error('account changed');
        // Never release the operation on an unknown outcome: the server may already have committed its successor.
        const response = await o.refresh(account.refreshToken, claim);
        if (owner !== generation) throw new Error('account changed');
        if (
          !response ||
          typeof response.access_token !== 'string' ||
          !response.access_token ||
          typeof response.refresh_token !== 'string' ||
          !response.refresh_token ||
          !Number.isSafeInteger(response.expires_in) ||
          response.expires_in <= 0 ||
          !Number.isSafeInteger(now() + response.expires_in * 1000)
        )
          throw new Error('invalid token response');
        const next = {
          ...account,
          accessToken: response.access_token,
          refreshToken: response.refresh_token,
          expiresAt: now() + response.expires_in * 1000,
        };
        await o.vault.completeRefresh(claim, account.refreshToken, next);
        if (owner !== generation) throw new Error('account changed');
        current = next;
        return next.accessToken;
      })();
      inflight = pending;
      try {
        return await pending;
      } finally {
        if (inflight === pending) inflight = null;
      }
    },
    /**
     * The token the relay accepts (audience `relay`), made from a good access token and kept until a minute before it ends; `force` makes
     * a new one. One request at a time per sign-in, and an answer for a sign-in that has since changed is thrown away.
     */
    async relayToken(force = false) {
      if (!current) throw new Error('sign in required');
      const mint = o.relayToken;
      if (!mint) throw new Error('no relay token source');
      const owner = generation;
      const account = current;
      if (!force && relay && relay.owner === owner && relay.exp > now() + 60000) return relay.token;
      if (relaying) return relaying;
      const pending = (async () => {
        const response = await mint(await auth.token());
        // the sign-in may have been replaced meanwhile: by another one (generation), or by a restore that was still reading the vault
        if (owner !== generation || current?.deviceId !== account.deviceId) throw new Error('account changed');
        if (
          !response ||
          typeof response.token !== 'string' ||
          !response.token ||
          !Number.isSafeInteger(response.expires_in) ||
          response.expires_in <= 0 ||
          !Number.isSafeInteger(now() + response.expires_in * 1000)
        )
          throw new Error('invalid relay token response');
        relay = { owner, token: response.token, exp: now() + response.expires_in * 1000 };
        return relay.token;
      })();
      relaying = pending;
      try {
        return await pending;
      } finally {
        if (relaying === pending) relaying = null;
      }
    },
  };
  return auth;
}
