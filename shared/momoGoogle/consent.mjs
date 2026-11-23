// Google sign-in that finishes on the home: the home makes a one-time consent (PKCE verifier + sealing key, in memory only), a client catches the browser's redirect and seals the code to that key, and the home exchanges the code itself, so the tokens exist only on the home.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AccountError } from './account.mjs';
import { handoffContext } from './handoff.mjs';
import { iosRedirect } from './clientConfig.mjs';
import { READ_SCOPES, SEND_SCOPE } from './types.mjs';
/** A consent is good for ten minutes; at most this many wait at once (a new one pushes the oldest out). */
const FLOW_MS = 10 * 60_000;
const MAX_FLOWS = 8;
/** A flow that got this many hand-offs it could not open or check is dropped: a flow id alone must not be enough to keep it from its owner, nor to try for ever. */
const MAX_BAD_HANDOFFS = 3;
/** Only a loopback redirect on the client is accepted: Google's desktop clients allow nothing else, and nothing else can steal the code. */
const LOOPBACK = /^http:\/\/127\.0\.0\.1:[0-9]{2,5}\/callback$/;
/** @typedef {'desktop' | 'ios'} ClientKind */
export class ConsentError extends Error {
  code;
  constructor(code) {
    super(`Google sign-in failed (${code})`);
    this.code = code;
  }
}
const b64 = (n) => randomBytes(n).toString('base64url');
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class GoogleConsent {
  #flows = new Map();
  deps;
  constructor(deps) {
    this.deps = deps;
  }
  /** How many sign-ins were begun and are still waiting (expired ones do not count). */
  pending() {
    const now = this.deps.now();
    return [...this.#flows.values()].filter((f) => f.expiresAt > now).length;
  }
  /**
   * Starts a consent: `read` for mail and calendar, `send` for the optional send-only step (needs a connected account). `client` is the OAuth client
   * the sign-in uses: 'desktop' (a loopback redirect on the Mac) or 'ios' (the app's own scheme, when the owner made an iOS client).
   * @param {{ purpose: 'read' | 'send', redirectUri: string, client: 'desktop' | 'ios' }} o
   */
  async begin(o) {
    const config = o.client === 'ios' ? this.deps.iosConfig : this.deps.config;
    if (!config) throw new ConsentError('no_ios_client');
    const redirectOk = o.client === 'ios' ? o.redirectUri === iosRedirect(config.clientId) : LOOPBACK.test(o.redirectUri);
    if (!redirectOk) throw new ConsentError('bad_redirect');
    const now = this.deps.now();
    for (const [id, f] of this.#flows) if (f.expiresAt <= now) this.#flows.delete(id);
    // the oldest waits no more rather than the newest being refused: a person who starts again always gets a sign-in
    if (this.#flows.size >= MAX_FLOWS) this.#flows.delete(/** @type {string} */ (this.#flows.keys().next().value));
    const existing = o.purpose === 'send' ? await this.deps.account.load() : null;
    if (o.purpose === 'send' && !existing) throw new ConsentError('no_account');
    const keys = this.deps.sealer.generateKeyPair();
    const flowId = b64(16);
    const flow = {
      purpose: o.purpose,
      client: o.client,
      state: b64(24),
      verifier: b64(32),
      redirectUri: o.redirectUri,
      privateKey: keys.privateKey,
      expiresAt: now + FLOW_MS,
    };
    this.#flows.set(flowId, flow);
    const url = new URL(config.authUri);
    const params = {
      client_id: config.clientId,
      redirect_uri: o.redirectUri,
      response_type: 'code',
      scope: (o.purpose === 'send' ? [SEND_SCOPE] : [...READ_SCOPES]).join(' '),
      state: flow.state,
      code_challenge: createHash('sha256').update(flow.verifier).digest('base64url'),
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
      ...(existing ? { include_granted_scopes: 'true', login_hint: existing.email } : {}),
    };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return { flowId, authUrl: url.toString(), sealTo: keys.publicKey, expiresAt: flow.expiresAt };
  }
  /** Finishes a consent from a sealed hand-off. A flow is used once, whatever happens. */
  async complete(flowId, sealed) {
    const flow = this.#flows.get(flowId);
    if (!flow) throw new ConsentError('unknown_flow');
    if (flow.expiresAt <= this.deps.now()) {
      this.#flows.delete(flowId);
      throw new ConsentError('expired');
    }
    // a hand-off that is not the client's (not sealed to this flow, a wrong state) is refused and the flow stays for the real one, a few tries only
    const reject = () => {
      flow.bad = (flow.bad ?? 0) + 1;
      if (flow.bad >= MAX_BAD_HANDOFFS) this.#flows.delete(flowId);
      return new ConsentError('invalid');
    };
    let hand;
    try {
      hand = JSON.parse(this.deps.sealer.open(flow.privateKey, sealed, handoffContext(flowId)));
    } catch {
      throw reject();
    }
    if (typeof hand?.state !== 'string' || !same(hand.state, flow.state) || hand.redirectUri !== flow.redirectUri) throw reject();
    // from here the hand-off is the client's, and the flow is used whatever comes of it
    this.#flows.delete(flowId);
    if (hand.error) throw new ConsentError('denied');
    if (typeof hand.code !== 'string' || !hand.code) throw new ConsentError('invalid');
    // read before the exchange: if the account changes, is disposed or this home is wiped or moved while Google answers, the grant is not saved
    const generation = this.deps.account.generation();
    const tokens = await this.#exchange(hand.code, flow);
    const { email, subject } = tokens;
    const needed = flow.purpose === 'send' ? [SEND_SCOPE] : READ_SCOPES.filter((s) => s !== 'openid' && s !== 'email');
    // a grant that is not kept is revoked at Google (best effort, bounded), so no refresh token is left that nothing here knows of
    const refuse = async (code) => {
      await this.deps.account.revokeToken(tokens.refreshToken);
      return new ConsentError(code);
    };
    if (!needed.every((s) => tokens.scopes.includes(s))) throw await refuse('scope_missing');
    let saved;
    try {
      saved = await this.deps.account.connect({
        email,
        subject,
        tokens: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, scopes: tokens.scopes },
        client: flow.client,
        rule: flow.purpose,
        generation,
      });
    } catch (e) {
      if (!(e instanceof AccountError)) throw e;
      // wrong or different account, or the home moved on while Google answered
      throw await refuse(e.code === 'different_account' || e.code === 'wrong_account' ? e.code : 'superseded');
    }
    return { email, canSend: saved.tokens.scopes.includes(SEND_SCOPE) };
  }
  async #exchange(code, flow) {
    const config = /** @type {import('./types.mjs').ClientConfig} */ (flow.client === 'ios' ? this.deps.iosConfig : this.deps.config);
    let res;
    try {
      res = await this.deps.fetch(config.tokenUri, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: flow.verifier,
          redirect_uri: flow.redirectUri,
          client_id: config.clientId,
          // an iOS client has no secret: PKCE is its proof
          ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
        }).toString(),
      });
    } catch {
      throw new ConsentError('exchange_failed');
    }
    let body;
    try {
      body = await res.json();
    } catch {
      body = null; // not JSON: the exchange failed, which the check below reports
    }
    const who = idTokenClaims(body?.id_token);
    if (!res.ok || !body?.access_token || !body.refresh_token || !who) throw new ConsentError('exchange_failed');
    const expiresIn = Number(body.expires_in);
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: this.deps.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
      scopes: (body.scope ?? '').split(' ').filter(Boolean),
      email: who.email,
      subject: who.subject,
    };
  }
}
/**
 * The email and the Google account id (`sub`, which names the account for good; an address can change) in an ID token that came straight from
 * Google's token endpoint over TLS (not a token a third party handed over, so it is read, not verified).
 */
function idTokenClaims(idToken) {
  try {
    const claims = JSON.parse(Buffer.from((idToken ?? '').split('.')[1] ?? '', 'base64url').toString('utf8'));
    return claims.email && claims.sub ? { email: String(claims.email), subject: String(claims.sub) } : null;
  } catch {
    return null;
  }
}
