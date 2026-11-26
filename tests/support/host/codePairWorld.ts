// A controlled Host's pairing service on the relay's real rendezvous in process, and the controlling Mac's side of a run (the tests of host/src/codePairService.mjs share it).
import { mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createRendezvous } from '../../../relay/src/rendezvous.mjs';
// @ts-ignore
import { createCodePairService, POLL_MS } from '../../../host/src/codePairService.mjs';
// @ts-ignore
import { createCodePairBudgets } from '../../../host/src/codePairBudgets.mjs';
// @ts-ignore
import { createPairing } from '../../../host/src/pairing.mjs';
// @ts-ignore
import { createApprovalKeys, ENROL_TAG } from '../../../host/src/codePairApproval.mjs';
import { cp, crypto, A, B, device } from './codePairKit.ts';
import nodeCrypto from 'node:crypto';

export const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};
export const enrollment = {
  relayUrl: 'wss://relay.example/v1/ws',
  hostId: 'h_abcdefghijklmnop',
  secret: 'S'.repeat(43),
  pairId: 'p_abcdefgh',
  appPub: 'a'.repeat(43) + '=',
  appEphPub: 'b'.repeat(43) + '=',
};
export const half = { hostPub: 'k'.repeat(43) + '=', hostEphPub: 'e'.repeat(43) + '=' };

/** A Host's service on the relay's real rendezvous, and the controlling Mac's side of a run. */
export function world(t: any, over: Record<string, any> = {}) {
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-pair-svc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 1_000_000;
  const rv: any = createRendezvous({ now: () => clock });
  const relayCalls: string[] = [];
  const flags = { sendFails: false, allows: over.allows ?? true, open: true, saveFails: false, auditThrows: false };
  const forgot: string[] = [];
  const reported: string[] = [];
  const relay: any = {
    offer: async () => {
      if (over.relayOffer) return over.relayOffer();
      relayCalls.push('offer');
      if (over.offerFails) return { ok: false, reason: over.offerFails };
      const r = rv.offer({ account: 'acct', address: `10.0.0.${rv.offerCount ?? 1}` });
      return r.ok ? { ok: true, id: r.id, hint: r.hint, ticket: r.ticket, expiresAt: r.expiresAt } : { ok: false, reason: r.reason };
    },
    read: async (o: any) => {
      if (over.relayRead) return over.relayRead(o);
      const r = rv.read(o);
      return r.ok ? { ok: true, claims: r.claims, expiresAt: r.expiresAt, messages: r.messages } : { ok: false, reason: r.reason };
    },
    send: async (o: any) => {
      relayCalls.push('send');
      if (flags.sendFails) return { ok: false, reason: 'relay' };
      const r = rv.send(o);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason };
    },
    close: async (o: any) => {
      relayCalls.push('close');
      rv.close(o);
      return { ok: true };
    },
  };
  over.before?.(dir);
  const pairing = createPairing({ configDir: path.join(dir, 'config') });
  const audited: any[] = [];
  const enrolled: any[] = [];
  // `real`: the person's proof is made and checked with a real P-256 key (host/src/codePairApproval.mjs), and the controllers' records are believed only with it
  let real: any;
  if (over.real) {
    const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk: any = publicKey.export({ format: 'jwk' });
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64');
    const sign = (text: string) => nodeCrypto.sign('sha256', Buffer.from(text), { key: privateKey, dsaEncoding: 'der' }).toString('base64');
    const keys = createApprovalKeys({
      configDir: path.join(dir, 'config'),
      hostId: () => pairing.hostId(),
      controllers: () => pairing.controllerRecords(),
      platform: 'darwin',
      now: () => clock,
    });
    keys.enrol({ key: point, weak: false, signature: sign([ENROL_TAG, pairing.hostId(), point, 'strong'].join('|')) });
    pairing.believeControllers((record: any) => keys.verifyRecord(record));
    real = { keys, sign };
  }
  const service = createCodePairService({
    relay,
    crypto,
    device: B,
    budgets: createCodePairBudgets({ file: path.join(dir, 'code-pair.json'), now: () => clock }),
    policy: { allowsClient: () => flags.allows },
    pairing,
    forget: ({ hostId }: { hostId: string }) => void forgot.push(hostId),
    open: () => flags.open,
    setOpen: (v: boolean) => {
      // off is off in this process even when it could not be kept (host/src/codePairWiring.mjs)
      if (!v) flags.open = false;
      if (flags.saveFails) throw new Error('disk full');
      flags.open = v;
    },
    enroll: (p: any) => {
      if (over.enrollFails) throw new Error('relay link refused');
      enrolled.push(p);
      return half;
    },
    approvals: real
      ? { status: real.keys.status, hostId: () => pairing.hostId(), verify: real.keys.verify, reset: real.keys.reset }
      : {
          status: () => (over.unavailable ? { available: false, reason: over.unavailable } : { available: true, weak: false }),
          hostId: () => 'host-h',
          ...('verify' in over ? { verify: over.verify } : { verify: async () => true }),
          ...('reset' in over ? { reset: over.reset } : {}),
        },
    ...(over.bare
      ? {}
      : {
          audit: (e: any) => {
            if (flags.auditThrows) throw new Error('audit down');
            audited.push(e);
          },
          report: (m: string) => void reported.push(m),
          random: (n: number) => new Uint8Array(n).map((_, i) => (i * 37 + 11) % 256),
        }),
    now: () => clock,
  });
  const events: any[] = [];
  const owner = new Set<() => void>();
  const who = { owner, emit: (m: any) => events.push(m), ends: owner };
  const phases = () => events.map((e) => e.phase);
  const pump = async () => {
    mock.timers.tick(POLL_MS);
    await flush();
  };
  /** The controlling Mac typing a code: claims it at the relay and walks the four messages as far as asked. */
  const typing = (code: string, opts: { secret?: string } = {}) => {
    const { hint, secret } = cp.parseCode(code) as any;
    const claimed: any = rv.claim({ hint, address: '10.1.1.1' });
    const a = cp.createInitiator({
      crypto,
      secret: opts.secret ?? secret,
      hint,
      rendezvousId: claimed.id,
      claims: claimed.claims,
      device: over.peer ? device(over.peer) : A,
      budget: cp.createRunBudget(),
    });
    const send = (box: string) => rv.send({ id: claimed.id, ticket: claimed.ticket, claims: claimed.claims, box });
    const read = (after = 0): any => rv.read({ id: claimed.id, ticket: claimed.ticket, after });
    return { a, claimed, send, read };
  };
  /** A run up to the person's question. */
  async function toConfirm(code: string) {
    const x = typing(code);
    x.send(x.a.first());
    await pump();
    const m2 = x.read().messages.at(-1)!.box;
    x.send(x.a.second(m2, enrollment));
    await pump();
    return x;
  }
  /** The person's allowing on this Mac, as the app does it: the text to be signed is asked for, then the answer with its proof. */
  const accept = async (offerId: string, as: any = who, approval: unknown = {}) => {
    const asked = service.approvalText({ offerId }, as);
    return service.answer({ offerId, accept: true, approval: real ? { sig: real.sign(asked.text) } : approval }, as);
  };
  return {
    accept,
    flags,
    forgot,
    reported,
    service,
    who,
    owner,
    events,
    phases,
    pump,
    typing,
    toConfirm,
    rv,
    pairing,
    audited,
    enrolled,
    relayCalls,
    tick: (ms: number) => void (clock += ms),
    dir,
  };
}
export const OFFER = { relayUrl: 'https://relay.example', token: 'tok' };
