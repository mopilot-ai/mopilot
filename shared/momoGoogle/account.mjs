// MoMo's Google account on the home: the sealed tokens, a single-flight refresh, the "source disconnected" state with its cause, disconnect with revoke.
import { READ_ACCESS, SEND_SCOPE } from './types.mjs';
const DAY_MS = 86_400_000;
/** Google ends the refresh tokens of an app in Testing mode after 7 days; an invalid grant near that age is called by its name. */
const TESTING_TOKEN_LIFE_MS = 6.5 * DAY_MS;
/** A token this close to its end is refreshed first. */
const SKEW_MS = 60_000;
/** The longest a revoke at Google is waited for: it is best effort, and nothing local waits behind it. */
const REVOKE_MS = 3000;
/**
 * Revokes a refresh token at Google, waiting `ms` at most: true when Google says it is no longer valid (a 400 means it was already gone), false
 * when Google or the network did not say so. It follows no redirect, so the token only ever goes to the revoke address.
 * @param {{ fetch: typeof fetch, revokeUri: string, token: string, ms?: number }} o
 */
export async function revokeGrant({ fetch: doFetch, revokeUri, token, ms = REVOKE_MS }) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref();
  });
  const asked = Promise.resolve()
    .then(() =>
      doFetch(revokeUri, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
      }),
    )
    .then(
      (res) => res.ok || res.status === 400,
      () => false,
    );
  const revoked = await Promise.race([asked, late]);
  clearTimeout(timer);
  return revoked;
}
/** The account cannot be used now; `cause` says why when the user can fix it by signing in again. */
export class AccountError extends Error {
  code;
  cause_;
  constructor(code, cause_) {
    super(
      code === 'unavailable'
        ? 'Google could not be reached'
        : code === 'not_connected'
          ? 'Google is not connected'
          : code === 'different_account' || code === 'wrong_account'
            ? 'That is not the Google account MoMo is connected to'
            : `Google needs a new sign-in (${cause_})`,
    );
    this.code = code;
    this.cause_ = cause_;
  }
}
export class GoogleAccount {
  #inflight = null;
  /** The generation the in-flight refresh began under: a sign-in or a disconnect since then makes the next read start its own. */
  #inflightGeneration = -1;
  /** Bumped by every change of who is connected (connect, disconnect, import, dispose): work begun under an older one never saves. */
  #generation = 0;
  #disposed = false;
  /** Changes take turns, so a refresh that finishes late meets the disconnect or the new sign-in that came first. */
  #queue = Promise.resolve();
  deps;
  constructor(deps) {
    this.deps = deps;
  }
  /** Runs `step` after the changes before it, and whatever it throws does not stop the ones after. */
  async #serial(step) {
    const before = this.#queue;
    let release;
    this.#queue = new Promise((resolve) => {
      release = resolve;
    });
    await before;
    try {
      return await step();
    } finally {
      release();
    }
  }
  async status() {
    const a = await this.deps.file.load();
    if (!a) return { state: 'not_connected' };
    if (a.needsSignIn) return { state: 'needs_sign_in', email: a.email, cause: a.needsSignIn.cause, since: a.needsSignIn.since };
    return { state: 'connected', email: a.email, canSend: a.tokens.scopes.includes(SEND_SCOPE), connectedAt: a.connectedAt };
  }
  /** The record, for callers that need the connect day or the granted scopes (never for a log). */
  load() {
    return this.deps.file.load();
  }
  /** Who is connected changes with every `connect`, `disconnect` and `dispose`; work begun under an older value must not save. */
  generation() {
    return this.#generation;
  }
  /**
   * Saves the tokens of a finished sign-in, in one step with the checks that decide it: refused (`not_connected`) when this object was disposed or
   * the connected account changed since `generation` was read (a wipe, a move, a disconnect or another sign-in came first), and refused when the
   * account is not the right one: a `read` sign-in may only replace the same Google account (`different_account`), a `send` step only adds to the
   * same account on the same client (`wrong_account`). The caller revokes a grant that was refused. The same account signing in again keeps the
   * day it was first connected, and the send step keeps the read scopes; the grant's own age (`grantedAt`) is always the new one.
   * @param {{ email: string, subject: string, tokens: import('./types.mjs').Tokens, client: 'desktop' | 'ios', rule: 'read' | 'send', generation: number }} o
   */
  connect({ email, subject, tokens, client, rule, generation }) {
    return this.#serial(async () => {
      if (this.#disposed || generation !== this.#generation) throw new AccountError('not_connected');
      const prior = await this.deps.file.load();
      if (rule === 'send' && (!prior || prior.subject !== subject || (prior.client === 'ios') !== (client === 'ios')))
        throw new AccountError('wrong_account');
      if (rule === 'read' && prior && prior.subject !== subject) throw new AccountError('different_account');
      const at = this.deps.now();
      const scopes =
        rule === 'send'
          ? [...new Set([.../** @type {NonNullable<typeof prior>} */ (prior).tokens.scopes, ...tokens.scopes])]
          : tokens.scopes;
      const saved = {
        version: 1,
        email,
        subject,
        connectedAt: prior ? prior.connectedAt : at,
        grantedAt: at,
        tokens: { ...tokens, scopes },
        client,
      };
      this.#generation++;
      await this.deps.file.save(saved);
      return saved;
    });
  }
  /** A valid access token, refreshed when it is near its end; one refresh at a time. */
  accessToken() {
    if (!this.#inflight || this.#inflightGeneration !== this.#generation) {
      this.#inflightGeneration = this.#generation;
      const run = this.#token().finally(() => {
        if (this.#inflight === run) this.#inflight = null;
      });
      this.#inflight = run;
    }
    return this.#inflight;
  }
  /** An access token with the generation it belongs to: a read that fails with it says so with the same `generation`, and only that account is marked. */
  async access() {
    const generation = this.#generation;
    return { token: await this.accessToken(), generation };
  }
  /** The access token in hand was refused: the next `accessToken` asks Google for a new one. */
  invalidate(generation) {
    return this.#serial(async () => {
      const a = this.#generation === generation ? await this.deps.file.load() : null;
      if (a) await this.deps.file.save({ ...a, tokens: { ...a.tokens, expiresAt: 0 } });
    });
  }
  /** Marks the account as needing a new sign-in (a read got a 401 the refresh could not cure, or a scope is gone). */
  markNeedsSignIn(cause, generation) {
    return this.#serial(async () => {
      // a read that began under an older account (before a disconnect and a new sign-in) says nothing about the one connected now
      const a = this.#generation === generation ? await this.deps.file.load() : null;
      if (a) await this.deps.file.save({ ...a, needsSignIn: { cause, since: this.deps.now() } });
    });
  }
  /**
   * Revokes the grant at Google first, while the record still exists, then forgets the account. A refresh that was on its way meets a new generation
   * and an empty file and drops its result. When Google could not be asked (or did not say yes) `owedToken` is the refresh token that is still live:
   * the caller keeps it owed and tries again, because nothing here can once the record is gone.
   * @returns {Promise<{ revoked: boolean, owedToken: string | null }>}
   */
  async disconnect() {
    const kept = await this.#serial(async () => {
      const a = await this.deps.file.load();
      if (a) this.#generation++;
      return a;
    });
    if (!kept) return { revoked: false, owedToken: null };
    const revoked = await this.#revoke(kept.tokens.refreshToken);
    await this.#serial(() => this.deps.file.clear());
    return { revoked, owedToken: revoked ? null : kept.tokens.refreshToken };
  }
  /** Revokes a refresh token at Google; false when Google or the network did not say yes. */
  #revoke(token) {
    return revokeGrant({ fetch: this.deps.fetch, revokeUri: this.deps.config.revokeUri, token, ms: this.deps.revokeMs ?? REVOKE_MS });
  }
  /** Revokes a grant that was not kept (a sign-in for another account): best effort. */
  revokeToken(token) {
    return this.#revoke(token);
  }
  /** This object is done (the lease changed, MoMo was reset): every call from now on says nothing is connected, and a refresh on its way saves nothing. */
  dispose() {
    this.#disposed = true;
    this.#generation++;
  }
  async #token() {
    if (this.#disposed) throw new AccountError('not_connected');
    const generation = this.#generation;
    const a = await this.deps.file.load();
    if (!a) throw new AccountError('not_connected');
    if (a.needsSignIn) throw new AccountError('needs_sign_in', a.needsSignIn.cause);
    if (a.tokens.expiresAt - SKEW_MS > this.deps.now()) return a.tokens.accessToken;
    // the client that made the grant refreshes it: an iOS grant with no iOS client configured here cannot be used until it is made again
    const config = a.client === 'ios' ? this.deps.iosConfig : this.deps.config;
    if (!config)
      return this.#settle(
        generation,
        a,
        (cur) => ({ ...cur, needsSignIn: { cause: 'client_rejected', since: this.deps.now() } }),
        new AccountError('needs_sign_in', 'client_rejected'),
      );
    let res;
    try {
      res = await this.deps.fetch(config.tokenUri, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: config.clientId,
          ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
          refresh_token: a.tokens.refreshToken,
        }).toString(),
      });
    } catch {
      throw new AccountError('unavailable');
    }
    let body;
    try {
      body = await res.json();
    } catch {
      // an answer that is not JSON (a proxy's page) is read as "no answer": a refusal then counts as unavailable, never as a revoked grant
      body = null;
    }
    if (!res.ok) {
      const cause = refusalCause(body?.error, a, this.deps);
      if (!cause) throw new AccountError('unavailable');
      return this.#settle(
        generation,
        a,
        (cur) => ({ ...cur, needsSignIn: { cause, since: this.deps.now() } }),
        new AccountError('needs_sign_in', cause),
      );
    }
    if (typeof body?.access_token !== 'string' || !body.access_token) throw new AccountError('unavailable');
    const expiresIn = Number(body.expires_in);
    const tokens = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token || a.tokens.refreshToken,
      expiresAt: this.deps.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
      scopes: typeof body.scope === 'string' && body.scope ? body.scope.split(' ') : a.tokens.scopes,
    };
    // what Google says is granted now is what counts: a grant that lost a read scope is not a working one
    if (!READ_ACCESS.every((scope) => tokens.scopes.includes(scope)))
      return this.#settle(
        generation,
        a,
        (cur) => ({ ...cur, needsSignIn: { cause: 'scope_missing', since: this.deps.now() } }),
        new AccountError('needs_sign_in', 'scope_missing'),
      );
    await this.#settle(generation, a, (cur) => ({ ...cur, tokens }));
    return tokens.accessToken;
  }
  /**
   * Saves what a refresh learned, but only into the very record it started from: if the account was disconnected, replaced, moved or disposed while
   * Google was answering, the result is dropped and the caller is told nothing is connected. With `then`, that error is thrown after saving.
   */
  #settle(generation, started, change, then) {
    return this.#serial(async () => {
      const cur = this.#generation === generation && !this.#disposed ? await this.deps.file.load() : null;
      if (!cur || cur.tokens.refreshToken !== started.tokens.refreshToken || cur.grantedAt !== started.grantedAt)
        throw new AccountError('not_connected');
      await this.deps.file.save(change(cur));
      if (then) throw then;
    });
  }
}
/** The cause for a refusal at the token endpoint; null when it is not the user's grant that ended (a 5xx, a rate limit). */
function refusalCause(error, a, deps) {
  if (error === 'invalid_grant')
    return deps.testingMode && deps.now() - a.grantedAt >= TESTING_TOKEN_LIFE_MS ? 'testing_expired' : 'revoked';
  if (error === 'invalid_client' || error === 'unauthorized_client') return 'client_rejected';
  return null;
}
