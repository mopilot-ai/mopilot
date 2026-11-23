// A MoMo home on a scratch Host dir with its Google source over a fake Google, for the Host-side connector tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMomoGoogle } from '../../host/src/momoGoogle.mjs';
import { createMomoHome } from '../../host/src/momoHome.mjs';
import { createFileSafeStorage } from '../../host/src/secretStore.mjs';
import { parseCallback } from '../../shared/momoGoogle/handoff.mjs';
import { createSealer } from '../../shared/momoGoogle/seal.mjs';
import type { Catcher } from '../../shared/momoGoogle/signIn.mjs';
import { createNodePrimitives } from '../../shared/remote/nodePrimitives.mjs';
import { READ_SCOPES } from '../../shared/momoGoogle/types.mjs';
import { idToken, startFake, type FakeAnswer, type FakeRequest } from './fakeGoogle.ts';

export const sealer = createSealer(createNodePrimitives());
export const CLIENT_JSON = JSON.stringify({
  installed: {
    client_id: 'desk-id',
    client_secret: 'desk-secret',
    auth_uri: 'https://accounts.example/auth',
    token_uri: 'https://accounts.example/token',
  },
});
export const REDIRECT = 'http://127.0.0.1:53682/callback';

/** What a client's catcher does with a consent URL: answers with the redirect the browser would have produced. */
export function fakeCatcher(answer: (authUrl: URL) => Record<string, string> | null, redirectUri = REDIRECT): () => Promise<Catcher> {
  return async () => {
    let hand: ReturnType<typeof parseCallback> = null;
    return {
      redirectUri,
      open: async (url) => {
        const extra = answer(new URL(url));
        hand = extra
          ? parseCallback(
              `${new URL(redirectUri).pathname}?${new URLSearchParams({ state: new URL(url).searchParams.get('state') as string, ...extra })}`,
              redirectUri,
            )
          : null;
      },
      wait: async () => hand,
      close: () => undefined,
    };
  };
}

export async function homeWorld(
  t: { after(f: () => void): void },
  o: {
    start?: boolean;
    wipeRevokeMs?: number;
    instantRetries?: boolean;
    timeZone?: string;
    gmail?: (r: FakeRequest) => FakeAnswer | undefined;
    token?: (r: FakeRequest) => FakeAnswer | undefined;
    revoke?: (r: FakeRequest) => FakeAnswer | undefined;
    /** Plug the service into the home the way host/src/momoServices/google.mjs does (a Reset and a move reach it), with an audit line sink in place of the gate. */
    register?: boolean;
    owedEveryMs?: number;
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-google-home-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { at: 1_700_000_000_000, now: () => clock.at };
  const fake = await startFake((r) => {
    if (r.path === '/token')
      return (
        o.token ??
        (() => ({
          body: {
            access_token: 'at1',
            refresh_token: 'rt1',
            expires_in: 3600,
            scope: READ_SCOPES.join(' '),
            id_token: idToken('me@example.com'),
          },
        }))
      )(r);
    if (r.path === '/revoke') return o.revoke?.(r) ?? { body: {} };
    return o.gmail?.(r);
  });
  t.after(() => void fake.close());
  const home = createMomoHome({
    hostId: 'home-aaaa-1111',
    dataDir: path.join(dir, 'data'),
    safeStorage: createFileSafeStorage(path.join(dir, 'config')),
    clock,
    report: () => undefined,
  });
  if (o.start !== false) {
    await home.grant({ account: 'a1', features: ['momo'] });
    await home.start({ name: 'Studio' });
  }
  /** The only network this world has: Google's public revoke address goes to the fake, anything else outside it is an error. */
  const guarded: typeof fake.fetch = (url, init) => {
    const to = url === 'https://oauth2.googleapis.com/revoke' ? `${fake.url}/revoke` : url;
    if (!to.startsWith(fake.url)) throw new Error(`a test reached the network: ${url}`);
    return fake.fetch(to, init);
  };
  const google = createMomoGoogle({
    home,
    fetch: guarded as typeof fetch,
    now: clock.now,
    oauth: { authUri: `${fake.url}/auth`, tokenUri: `${fake.url}/token`, revokeUri: `${fake.url}/revoke` },
    ...(o.timeZone ? { timeZone: o.timeZone } : {}),
    ...(o.instantRetries ? { sleep: async () => undefined } : {}),
    ...(o.wipeRevokeMs ? { wipeRevokeMs: o.wipeRevokeMs } : {}),
    ...(o.owedEveryMs ? { owedEveryMs: o.owedEveryMs } : {}),
    endpoints: { gmail: `${fake.url}/`, calendar: `${fake.url}/` },
  });
  /** The client JSON pointed at the fake's endpoints. */
  const json = JSON.stringify({
    installed: { client_id: 'desk-id', client_secret: 'desk-secret', auth_uri: `${fake.url}/auth`, token_uri: `${fake.url}/token` },
  });
  /** What the audit log was told (the gate service's `audit`), when the world has one. */
  const audited: { event: string; reason?: string; by?: string }[] = [];
  if (o.register) {
    home.provide('google', google);
    home.use('google', { start: () => google.start(), pause: () => google.pause(), wipe: () => google.wipe(), seed: () => google.seed() });
    home.provide('gate', { audit: async (e: { event: string; reason?: string; by?: string }) => (audited.push(e), true) });
  }
  return { dir, clock, fake, home, google, json, audited, momoDir: path.join(dir, 'data', 'momo') };
}
