// A stateless streamable HTTP MCP server on 127.0.0.1 (the SDK's own server transport) for the gateway tests: it answers only the requests `ok` allows (401 otherwise), records each request's Authorization header and URL, and lists a read-only `whoami` and a changing `post`.
import { after } from 'node:test';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const READ = { type: 'object', properties: {} };

/** A stateless MCP server that answers only requests `ok(req)` allows; every request's auth is recorded. */
export async function httpServer(ok: (req: http.IncomingMessage) => boolean) {
  const seen: { auth?: string; url?: string }[] = [];
  const srv = http.createServer(async (req, res) => {
    seen.push({ auth: req.headers.authorization, url: req.url });
    if (!ok(req)) return void res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
    const server = new Server({ name: 'h', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: 'whoami', description: 'Who.', inputSchema: READ, annotations: { readOnlyHint: true } },
        { name: 'post', description: 'Post.', inputSchema: READ },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req: any) => ({
      content: [{ type: 'text', text: req.params.name === 'post' ? 'posted' : 'you' }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => void transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  after(() => {
    srv.closeAllConnections();
    srv.close();
  });
  const { port } = srv.address() as any;
  return { url: `http://127.0.0.1:${port}/mcp`, seen };
}
