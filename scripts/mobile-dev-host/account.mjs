// DEV ONLY account service for the phone's sign-in: the endpoints the phone talks to (/desktop/authorize, /api/desktop/token, /api/desktop/relay-token) and the ES256 key that signs the tokens the local relay verifies. It approves every sign-in, so it must never face anything but a trusted LAN.
import { refreshSuccessor, validRefreshOperation } from '../../shared/remote/refreshOperation.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SignJWT, exportJWK, exportSPKI, generateKeyPair, importJWK, jwtVerify } from 'jose';

export const ISSUER = 'https://code.mopilot.ai';
export const REDIRECT = 'mopilot://auth/callback';
export const USER = Object.freeze({ id: 'dev-user', name: 'Dev', email: 'dev@mopilot.local' });
const TOKEN_TTL_S = 900;
const CODE_TTL_MS = 60_000;
/** Phones this host will sign in; a stranger on the network cannot grow the account file without bound. */
export const MAX_PHONES = 4;
const ID = /^[A-Za-z0-9_-]{4,64}$/;
/** The production /desktop/authorize page refuses any other state (web/lib/authorizeQuery.ts), so this stand-in does too: a phone that passes here passes there. */
const STATE = /^[A-Za-z0-9_-]{16,128}$/;

const sha256 = (/** @type {string} */ text, /** @type {'hex' | 'base64url'} */ enc) => createHash('sha256').update(text).digest(enc);

/** @param {import('node:http').IncomingMessage} req */
async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    if ((size += chunk.length) > 16_384) throw new Error('too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const send = (/** @type {import('node:http').ServerResponse} */ res, /** @type {number} */ status, /** @type {object} */ body) =>
  void res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));

/**
 * @param {object} o
 * @param {string} o.dir scratch folder; the key and the refresh tokens live in account.json there, so a restart keeps every signed-in phone
 * @param {boolean} [o.invited] whether the account has the Mobile Remote invite (default: it has)
 * @param {boolean} [o.host] whether the invited account also has Host (--fake-hosts; default off)
 * @param {() => number} [o.now]
 */
export async function createAccountService({ dir, now = Date.now, invited = true, host = false }) {
  const file = path.join(dir, 'account.json');
  /** @type {{ key: { private: object, public: object }, refresh: Record<string, string>, rotations?: Record<string, {deviceId: string, nextHash: string}>, revoked?: string[], phones: string[] }} */
  let saved;
  // writes run one after another, each through a temporary file, so a reader never sees half of one; a failed write fails its own caller only
  let busy = Promise.resolve();
  const persist = async () => {
    const before = busy;
    let release = /** @type {() => void} */ (/** @type {unknown} */ (undefined));
    busy = new Promise((resolve) => (release = resolve));
    await before;
    try {
      await writeFile(`${file}.tmp`, JSON.stringify(saved), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    } finally {
      release();
    }
  };
  try {
    saved = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    // a missing file starts an account; an unreadable one is not replaced (a new key would sign out every phone)
    if (/** @type {any} */ (error).code !== 'ENOENT') throw error;
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    saved = { key: { private: await exportJWK(privateKey), public: await exportJWK(publicKey) }, refresh: {}, phones: [] };
    await persist();
  }
  const privateKey = await importJWK(/** @type {any} */ (saved.key.private), 'ES256');
  const publicPem = await exportSPKI(/** @type {any} */ (await importJWK(/** @type {any} */ (saved.key.public), 'ES256')));
  /** @type {Map<string, { challenge: string, deviceId: string, expires: number }>} */
  const codes = new Map();
  let rotating = Promise.resolve();

  const publicKey = await importJWK(/** @type {any} */ (saved.key.public), 'ES256');
  /** `audience` is `desktop` for the account's access token and `relay` for the token a device shows the relay (the account service mints it from the access token). */
  const sign = (/** @type {string} */ deviceId, /** @type {boolean} */ phone, /** @type {'desktop' | 'relay'} */ audience = 'desktop') =>
    new SignJWT({ did: deviceId, ...(phone && { dk: 'phone' }) })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(ISSUER)
      .setAudience(audience)
      .setSubject(USER.id)
      .setIssuedAt()
      .setExpirationTime(Math.floor(now() / 1000) + TOKEN_TTL_S)
      .sign(privateKey);

  /** A new refresh token for the device, replacing `old` when the device presented one; nothing changes if the write fails. */
  async function issueRefresh(/** @type {string} */ deviceId, /** @type {string | null} */ old = null) {
    const token = `rt_${randomBytes(24).toString('base64url')}`;
    saved.refresh[token] = deviceId;
    if (old) delete saved.refresh[old];
    try {
      await persist();
    } catch (error) {
      delete saved.refresh[token];
      if (old) saved.refresh[old] = deviceId;
      throw error;
    }
    return token;
  }

  /** The browser step: no page, the redirect the app's sign-in session waits for. */
  async function authorize(/** @type {URL} */ url, /** @type {import('node:http').ServerResponse} */ res) {
    const q = url.searchParams;
    const installId = q.get('install_id') ?? '';
    const state = q.get('state');
    const challenge = q.get('code_challenge');
    if (
      q.get('redirect_uri') !== REDIRECT ||
      q.get('response_type') !== 'code' ||
      !state ||
      !STATE.test(state) ||
      !challenge ||
      q.get('code_challenge_method') !== 'S256'
    )
      return send(res, 400, { error: 'invalid_request' });
    if (q.get('device_kind') !== 'phone' || !ID.test(installId)) return send(res, 400, { error: 'invalid_device' });
    const deviceId = `ph_${sha256(installId, 'hex').slice(0, 24)}`;
    if (!saved.phones.includes(deviceId)) {
      if (saved.phones.length >= MAX_PHONES) return send(res, 403, { error: 'too_many_phones' });
      saved.phones.push(deviceId);
    }
    for (const [spent, grant] of codes) if (grant.expires < now()) codes.delete(spent);
    const code = randomBytes(18).toString('base64url');
    codes.set(code, { challenge, deviceId, expires: now() + CODE_TTL_MS });
    await persist();
    const target = `${REDIRECT}?${new URLSearchParams({ code, state })}`;
    res.writeHead(302, { location: target, 'content-type': 'text/html' }).end(`<a href="${target}">Return to MoPilot</a>`);
  }

  async function token(
    /** @type {import('node:http').IncomingMessage} */ req,
    /** @type {import('node:http').ServerResponse} */ res,
    operationRequired = false,
  ) {
    let body;
    try {
      body = await readJson(req);
    } catch {
      return send(res, 400, { error: 'invalid_request' });
    }
    if (!body || typeof body !== 'object') return send(res, 400, { error: 'invalid_request' });
    if (operationRequired && body.grant_type !== 'refresh_token') return send(res, 400, { error: 'invalid_request' });
    if (body.grant_type === 'authorization_code') {
      const grant = codes.get(body.code);
      codes.delete(body.code);
      if (
        !grant ||
        grant.expires < now() ||
        body.redirect_uri !== REDIRECT ||
        typeof body.code_verifier !== 'string' ||
        sha256(body.code_verifier, 'base64url') !== grant.challenge
      )
        return send(res, 400, { error: 'invalid_grant' });
      return send(res, 200, {
        user: USER,
        device_id: grant.deviceId,
        device_kind: 'phone',
        access_token: await sign(grant.deviceId, true),
        refresh_token: await issueRefresh(grant.deviceId),
        expires_in: TOKEN_TTL_S,
      });
    }
    if (body.refresh_operation !== undefined && !validRefreshOperation(body.refresh_operation))
      return send(res, 400, { error: 'invalid_request' });
    if (body.grant_type !== 'refresh_token' || typeof body.refresh_token !== 'string') return send(res, 400, { error: 'invalid_grant' });
    if (operationRequired && !validRefreshOperation(body.refresh_operation)) return send(res, 400, { error: 'invalid_request' });
    const refusedStatus = operationRequired ? 401 : 400;
    // Serialize complete rotations, not only file writes: concurrent retries observe the committed receipt.
    const previous = rotating;
    let release;
    rotating = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const old = body.refresh_token;
      const operation = body.refresh_operation;
      const deviceId = saved.refresh[old];
      const receipt = saved.rotations?.[sha256(old, 'hex')];
      if (saved.revoked?.includes(deviceId ?? receipt?.deviceId ?? '')) return send(res, refusedStatus, { error: 'invalid_grant' });
      if (!deviceId) {
        if (!receipt) return send(res, refusedStatus, { error: 'invalid_grant' });
        if (operation === undefined || sha256(refreshSuccessor(old, receipt.deviceId, operation), 'hex') !== receipt.nextHash) {
          saved.revoked ??= [];
          saved.revoked.push(receipt.deviceId);
          const before = { ...saved.refresh };
          for (const [token, owner] of Object.entries(saved.refresh)) if (owner === receipt.deviceId) delete saved.refresh[token];
          try {
            await persist();
          } catch (error) {
            saved.refresh = before;
            saved.revoked.pop();
            throw error;
          }
          return send(res, refusedStatus, { error: 'token_reused' });
        }
        const candidate = refreshSuccessor(old, receipt.deviceId, operation);
        if (saved.refresh[candidate] !== receipt.deviceId) return send(res, refusedStatus, { error: 'refresh_superseded' });
        return send(res, 200, { access_token: await sign(receipt.deviceId, true), refresh_token: candidate, expires_in: TOKEN_TTL_S });
      }
      if (operation === undefined) {
        const replacement = await issueRefresh(deviceId, old);
        return send(res, 200, { access_token: await sign(deviceId, true), refresh_token: replacement, expires_in: TOKEN_TTL_S });
      }
      const replacement = refreshSuccessor(old, deviceId, operation);
      saved.rotations ??= {};
      saved.rotations[sha256(old, 'hex')] = { deviceId, nextHash: sha256(replacement, 'hex') };
      delete saved.refresh[old];
      saved.refresh[replacement] = deviceId;
      try {
        await persist();
      } catch (error) {
        saved.refresh[old] = deviceId;
        delete saved.refresh[replacement];
        delete saved.rotations[sha256(old, 'hex')];
        throw error;
      }
      return send(res, 200, { access_token: await sign(deviceId, true), refresh_token: replacement, expires_in: TOKEN_TTL_S });
    } finally {
      release();
    }
  }

  /** The relay token for the device an access token belongs to; an access token that is not ours, or ran out, gets 401. */
  async function relayToken(/** @type {import('node:http').IncomingMessage} */ req, /** @type {import('node:http').ServerResponse} */ res) {
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    try {
      const { payload } = await jwtVerify(String(bearer), publicKey, { issuer: ISSUER, audience: 'desktop' });
      if (typeof payload.did !== 'string' || saved.revoked?.includes(payload.did)) throw new Error('no device');
      return send(res, 200, { token: await sign(payload.did, payload.dk === 'phone', 'relay'), expires_in: TOKEN_TTL_S });
    } catch {
      return send(res, 401, { error: 'unauthorized' });
    }
  }

  return {
    publicPem,
    /** A signed token for a device: the Mac's (the relay's desktop kind) or a phone's, for the account (`desktop`) or the relay (`relay`). */
    sign,
    /** @returns {boolean} whether the request was an account route (and is answered) */
    handle(/** @type {import('node:http').IncomingMessage} */ req, /** @type {import('node:http').ServerResponse} */ res) {
      let url;
      try {
        url = new URL(String(req.url), 'http://host');
      } catch {
        return send(res, 400, { error: 'invalid_request' }), true;
      }
      const route =
        req.method === 'GET' && url.pathname === '/desktop/authorize'
          ? authorize(url, res)
          : req.method === 'POST' && ['/api/desktop/token', '/api/desktop/refresh'].includes(url.pathname)
            ? token(req, res, url.pathname === '/api/desktop/refresh')
            : req.method === 'POST' && url.pathname === '/api/desktop/relay-token'
              ? relayToken(req, res)
              : req.method === 'GET' && url.pathname === '/api/me'
                ? Promise.resolve(send(res, 200, { user: { ...USER, features: invited ? ['phone', ...(host ? ['host'] : [])] : [] } }))
                : null;
      if (!route) return false;
      route.catch(() => send(res, 500, { error: 'server_error' }));
      return true;
    },
  };
}
