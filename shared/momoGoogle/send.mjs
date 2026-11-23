// MoMo's optional send-only permission (D10): a `send` that only the approval gate can unlock, with a single-use grant tied to the exact message, and a plain "not granted" answer so the UI offers Copy / Open in Mail.
import { createHash, randomBytes } from 'node:crypto';
import { gmail as gmailApi } from '@googleapis/gmail';
import { OAuth2Client } from 'google-auth-library';
import { AccountError } from './account.mjs';
import { isScopeProblem, readError } from './errors.mjs';
const GRANT_MS = 10 * 60_000;
/** A digest of what will be sent, so a grant for one mail cannot send another. */
export function messageDigest(m) {
  return createHash('sha256')
    .update(JSON.stringify([m.to, m.cc ?? [], m.subject, m.body, m.threadId ?? '', m.inReplyTo ?? '', m.references ?? '']))
    .digest('hex');
}
/**
 * The grant book. `mint` belongs to the approval gate alone (the Host wires it only there); the sender gets `redeem`, which
 * consumes a grant: one use, for the message it was minted for, within ten minutes.
 */
export function createSendGrants(now) {
  const grants = new Map();
  return {
    mint(digest) {
      for (const [g, v] of grants) if (v.expiresAt <= now()) grants.delete(g);
      const grant = randomBytes(24).toString('base64url');
      grants.set(grant, { digest, expiresAt: now() + GRANT_MS });
      return grant;
    },
    redeem(grant, digest) {
      const v = grants.get(grant);
      grants.delete(grant);
      return !!v && v.expiresAt > now() && v.digest === digest;
    },
  };
}
export function createSender(o) {
  const canSend = async () => {
    const s = await o.account.status();
    return s.state === 'connected' && s.canSend;
  };
  return {
    canSend,
    async send(message, grant) {
      const status = await o.account.status();
      if (status.state === 'needs_sign_in') return { ok: false, reason: 'needs_sign_in' };
      if (status.state !== 'connected' || !status.canSend) return { ok: false, reason: 'not_granted' };
      // checked before the grant is spent, so an invalid message does not burn it; a missing or wrong grant sends nothing
      const raw = buildRaw(status.email, message);
      if (raw === null) return { ok: false, reason: 'invalid' };
      if (!grant || !o.redeem(grant, messageDigest(message))) return { ok: false, reason: 'no_permission' };
      let generation = -1;
      try {
        const auth = new OAuth2Client();
        const access = await o.account.access();
        generation = access.generation;
        auth.setCredentials({ access_token: access.token });
        const gmail = gmailApi({ version: 'v1', auth, rootUrl: o.endpoint, retry: false });
        const res = await gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw, ...(message.threadId ? { threadId: message.threadId } : {}) },
        });
        return res.data.id ? { ok: true, id: res.data.id } : { ok: false, reason: 'failed' };
      } catch (e) {
        if (e instanceof AccountError && e.code === 'needs_sign_in') return { ok: false, reason: 'needs_sign_in' };
        // a send is never retried (it could be sent twice); only a status and a reason are read of the raw error, which carries the bearer token
        const failure = readError(e);
        if (failure.status === 401 || isScopeProblem(failure)) {
          await o.account.markNeedsSignIn(failure.status === 401 ? 'revoked' : 'scope_missing', generation);
          return { ok: false, reason: 'needs_sign_in' };
        }
        return { ok: false, reason: 'failed' };
      }
    },
  };
}
/** What one approved mail may hold: more is not a mail MoMo writes, and Gmail's own limit is far above. */
const MAX_RECIPIENTS = 50;
const MAX_BODY = 100_000;
const MAX_SUBJECT = 500;
const ADDRESS = /^[^\s<>",;]+@[^\s<>",;]+$/;
const noBreak = (s) => !/[\r\n]/.test(s);
/** The RFC 5322 message as base64url, or null when an address or header value could inject another header. */
function buildRaw(from, m) {
  const to = m.to;
  const cc = m.cc ?? [];
  if (!to.length || to.length + cc.length > MAX_RECIPIENTS || ![...to, ...cc].every((a) => ADDRESS.test(a))) return null;
  if (m.body.length > MAX_BODY || m.subject.length > MAX_SUBJECT) return null;
  if (![m.subject, m.inReplyTo ?? '', m.references ?? ''].every(noBreak)) return null;
  const lines = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: =?UTF-8?B?${Buffer.from(m.subject, 'utf8').toString('base64')}?=`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.references ? [`References: ${m.references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(m.body, 'utf8')
      .toString('base64')
      .replace(/(.{76})/g, '$1\r\n'),
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}
