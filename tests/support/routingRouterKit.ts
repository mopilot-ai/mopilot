// The model router's tests' fakes (electron/routing/router.cjs): a provider on loopback that records each request, a translator that
// marks what it did, a router over fixed configs and keys, and a POST to it with its token.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRouter } = require('../../electron/routing/router.cjs');

export const KEY = 'sk-dummy-0000-test-key-abcd';
export type Handler = (req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) => void;

/** A fake provider: each request is recorded and answered by the handler for its path. */
export async function upstream(t: any, handlers: Record<string, Handler>) {
  const seen: { path: string; headers: http.IncomingHttpHeaders; body: Buffer }[] = [];
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      seen.push({ path: req.url ?? '', headers: req.headers, body });
      const h = handlers[(req.url ?? '').split('?')[0]] ?? handlers['*'];
      if (h) h(req, body, res);
      else res.writeHead(404).end('{"error":{"message":"no such path"}}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  t.after(() => (server.closeAllConnections(), server.close()));
  return { seen, base: `http://127.0.0.1:${(server.address() as any).port}`, server };
}

/** A translator that marks what it did, so a test can see the request and reply went through it. */
export const fakeTranslate = {
  async translateRequest(inbound: string, body: Buffer, config: any) {
    assert.equal(inbound, 'anthropic');
    const req = JSON.parse(body.toString());
    return {
      path: '/chat/completions',
      headers: { 'content-type': 'application/json', accept: req.stream ? 'text/event-stream' : 'application/json' },
      stream: !!req.stream,
      model: config.model,
      body: Buffer.from(JSON.stringify({ model: config.model, translated: true, messages: req.messages })),
    };
  },
  async translateResponse(_inbound: string, body: Buffer) {
    return Buffer.from(JSON.stringify({ type: 'message', from: JSON.parse(body.toString()) }));
  },
  StreamTranslator: class {
    open = true;
    finished = false;
    static made: any[] = [];
    config: any;
    constructor(_inbound: string, config: any) {
      this.config = config;
      (this.constructor as any).made.push(this);
    }
    push(bytes: Buffer) {
      // a provider's keep-alive comment is nothing to the caller; anything else is
      const text = bytes.toString().replace(/^: .*\n\n?/gm, '');
      return Buffer.from(text ? `event: t\ndata: ${text.trim()}\n\n` : '');
    }
    finish() {
      this.open = false;
      this.finished = true;
      return Buffer.from('event: message_stop\ndata: {}\n\n');
    }
    close() {
      this.open = false;
    }
  },
};

export const configOf = (o: Record<string, unknown> = {}) => ({
  id: 'c1',
  name: 'Work',
  provider: 'openai',
  model: 'gpt-test',
  tierModels: {},
  fallbacks: [],
  ...o,
});

export async function router(
  t: any,
  o: {
    configs?: Record<string, any>;
    keys?: Record<string, string>;
    bases?: Record<string, string>;
    timeouts?: any;
    translate?: any;
    bodyMax?: number;
  } = {},
) {
  const configs = o.configs ?? { c1: configOf() };
  const r = createRouter({
    configs: { get: (id: string) => configs[id] ?? null },
    keys: { get: (slot: string) => (o.keys ?? { openai: KEY })[slot] ?? null },
    translate: o.translate ?? fakeTranslate,
    bases: o.bases,
    timeouts: o.timeouts,
    bodyMax: o.bodyMax,
  });
  await r.start();
  t.after(() => r.stop());
  return r;
}

export type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };
export function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length, ...headers } },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (d) => parts.push(d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString() }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}
export const auth = (r: any) => ({ authorization: `Bearer ${r.token}` });
export const ask = (r: any, body: unknown, id = 'c1', path = 'v1/messages', headers: Record<string, string> = {}) =>
  post(`${r.baseFor(id)}/${path}`, body, { ...auth(r), ...headers });
