// A protected MCP server and its OAuth 2.1 authorization server on 127.0.0.1 (two origins), for the gateway's OAuth tests: the MCP server publishes protected-resource metadata (RFC 9728) and answers only a current access token; the authorization server publishes its metadata (RFC 8414), registers clients (RFC 7591), checks PKCE S256, the redirect, the state's round trip and the resource indicator (RFC 8707), issues expiring tokens and rotating refresh tokens, and records every request. `browser(url)` plays the user's browser: it follows the authorize redirect to the loopback callback.
import { after } from 'node:test';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const READ = { type: 'object', properties: {} };

async function listen(handler: http.RequestListener) {
  const srv = http.createServer(handler);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  after(() => {
    srv.closeAllConnections();
    srv.close();
  });
  return `http://127.0.0.1:${(srv.address() as any).port}`;
}

const body = (req: http.IncomingMessage) =>
  new Promise<string>((r) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => r(s));
  });
const json = (res: http.ServerResponse, status: number, v: unknown) =>
  void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));

/** legacy: no protected-resource metadata, the MCP server's origin serves the authorization server's metadata (the older MCP layout). */
export async function oauthWorld(o: { expiresIn?: number; registration?: boolean; prm?: boolean; legacy?: boolean } = {}) {
  const s: any = {
    requests: [] as { at: 'mcp' | 'as'; method: string; path: string; auth?: string; form?: Record<string, string> }[],
    clients: new Map<string, any>(),
    codes: new Map<string, any>(),
    access: new Set<string>(),
    refresh: new Set<string>(),
    n: 0,
    expiresIn: o.expiresIn ?? 3600,
    refuseRefresh: false,
    failToken: false,
    deny: false,
  };
  let asUrl = '';
  let mcpUrl = '';
  const issue = () => {
    const n = ++s.n;
    s.access.add(`at-${n}`);
    s.refresh.add(`rt-${n}`);
    if (s.badToken) return { access_token: 'bad\ntoken', token_type: 'Bearer' };
    // bare: no expiry, no scope, no new refresh token (all optional, RFC 6749 §5.1)
    if (s.bare) return { access_token: `at-${n}`, token_type: 'Bearer' };
    return { access_token: `at-${n}`, refresh_token: `rt-${n}`, token_type: 'Bearer', expires_in: s.expiresIn, scope: 'mcp' };
  };
  asUrl = await listen(async (req, res) => {
    const url = new URL(req.url!, asUrl);
    const raw = req.method === 'POST' ? await body(req) : '';
    const form = req.headers['content-type']?.includes('x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(raw)) : undefined;
    s.requests.push({ at: 'as', method: req.method!, path: url.pathname + url.search, form });
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json(res, 200, {
        issuer: asUrl,
        authorization_endpoint: `${asUrl}/authorize`,
        token_endpoint: `${asUrl}/token`,
        ...(o.registration === false ? {} : { registration_endpoint: `${asUrl}/register` }),
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
      });
    if (url.pathname === '/register') {
      const meta = JSON.parse(raw);
      const id = `client-${s.clients.size + 1}`;
      s.clients.set(id, meta);
      return json(res, 201, {
        ...meta,
        client_id: s.badClient ? 'bad\nid' : id,
        ...(s.clientSecret ? { client_secret: 'shh', client_secret_expires_at: 0 } : {}),
      });
    }
    if (url.pathname === '/authorize') {
      const q = Object.fromEntries(url.searchParams);
      s.lastAuthorize = q;
      const client = s.clients.get(q.client_id);
      if (!client || !client.redirect_uris.includes(q.redirect_uri) || q.code_challenge_method !== 'S256' || q.resource !== `${mcpUrl}/mcp`)
        return json(res, 400, { error: 'invalid_request' });
      const back = new URL(q.redirect_uri);
      back.searchParams.set('state', q.state);
      if (s.deny) back.searchParams.set('error', typeof s.deny === 'string' ? s.deny : 'access_denied');
      else {
        const code = `code-${crypto.randomUUID()}`;
        s.codes.set(code, q);
        back.searchParams.set('code', code);
      }
      return void res.writeHead(302, { location: back.href }).end();
    }
    if (url.pathname === '/token') {
      if (s.failToken) return json(res, 500, { error: 'server_error' });
      const f = form ?? {};
      if (f.resource !== `${mcpUrl}/mcp`) return json(res, 400, { error: 'invalid_target' });
      if (f.grant_type === 'authorization_code') {
        const q = s.codes.get(f.code);
        s.codes.delete(f.code);
        const challenge = crypto
          .createHash('sha256')
          .update(f.code_verifier ?? '')
          .digest('base64url');
        if (!q || q.client_id !== f.client_id || q.redirect_uri !== f.redirect_uri || q.code_challenge !== challenge)
          return json(res, 400, { error: 'invalid_grant' });
        return json(res, 200, issue());
      }
      if (f.grant_type === 'refresh_token') {
        if (s.refuseRefresh || !s.refresh.has(f.refresh_token)) return json(res, 400, { error: 'invalid_grant' });
        s.refresh.delete(f.refresh_token);
        if (s.holdRefresh) await s.holdRefresh;
        return json(res, 200, issue());
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    json(res, 404, { error: 'not_found' });
  });
  mcpUrl = await listen(async (req, res) => {
    const url = new URL(req.url!, mcpUrl);
    s.requests.push({ at: 'mcp', method: req.method!, path: url.pathname, auth: req.headers.authorization });
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return o.prm === false || o.legacy
        ? json(res, 404, {})
        : json(res, 200, { resource: `${mcpUrl}/mcp`, authorization_servers: [asUrl], scopes_supported: ['mcp'] });
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return o.legacy
        ? json(res, 200, {
            issuer: mcpUrl,
            authorization_endpoint: `${asUrl}/authorize`,
            token_endpoint: `${asUrl}/token`,
            registration_endpoint: `${asUrl}/register`,
            response_types_supported: ['code'],
          })
        : json(res, 404, {});
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    if (!token || !s.access.has(token) || s.revoked?.has(token))
      return void res
        .writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${mcpUrl}/.well-known/oauth-protected-resource/mcp"` })
        .end();
    const server = new Server({ name: 'p', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'me', description: 'Me.', inputSchema: READ, annotations: { readOnlyHint: true } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: `as ${token}` }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => void transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  /** The user's browser: opens the authorize URL and follows its redirect to the loopback callback. */
  const browser = async (url: string) => {
    s.opened = url;
    const r = await fetch(url, { redirect: 'manual' });
    const location = r.headers.get('location');
    if (!location) throw new Error(`authorize answered ${r.status}`);
    await fetch(location);
  };
  return { s, asUrl, mcpUrl: `${mcpUrl}/mcp`, browser };
}
