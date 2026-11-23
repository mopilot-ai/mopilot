// A fake Google on a loopback port for the MoMo Google connector tests: OAuth endpoints, Gmail and Calendar, answered by a handler the test supplies; no real network, no real secrets.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ClientConfig, Fetch } from '../../shared/momoGoogle/types.mjs';

export type FakeRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  form: URLSearchParams;
  json: any;
  auth: string | undefined;
};
export type FakeAnswer = { status?: number; body?: unknown };
export type Fake = { url: string; requests: FakeRequest[]; close(): Promise<void>; config: ClientConfig; fetch: Fetch };

export async function startFake(handler: (r: FakeRequest) => FakeAnswer | undefined): Promise<Fake> {
  const requests: FakeRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const text = Buffer.concat(chunks).toString('utf8');
      const type = String(req.headers['content-type'] ?? '');
      const r: FakeRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        form: type.includes('x-www-form-urlencoded') ? new URLSearchParams(text) : new URLSearchParams(),
        json: type.includes('json') && text ? JSON.parse(text) : null,
        auth: req.headers.authorization,
      };
      requests.push(r);
      const a = handler(r) ?? { status: 404, body: { error: 'not_found' } };
      res.writeHead(a.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(a.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    config: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      authUri: `${url}/auth`,
      tokenUri: `${url}/token`,
      revokeUri: `${url}/revoke`,
    },
    fetch: (u, init) => fetch(u, init),
  };
}

/** An ID token carrying only an email claim (unsigned: the code reads it, never verifies it). */
export const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email, sub: `sub-${email}` })).toString('base64url')}.y`;
