// The gateway's client of one MCP server (#2999 C0; MoMo's servers and the gateway's managed ones), on the maintained @modelcontextprotocol/sdk: a stdio server runs as a child process of its own, with only the env its config declares (a ${VAR} or ${VAR:-default} in a declared value is filled from this process, as coding chats fill it) plus PATH and HOME (the SDK also adds the non-secret LOGNAME, SHELL, TERM and USER), never main's other environment, provider keys or the token vault's tokens; its stderr is dropped, so nothing it prints is logged. A streamable HTTP server is reached with its configured headers, plus a managed server's credential (gateway/auth.cjs), which is never filled from the environment.
const os = require('node:os');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

/** ${VAR} and ${VAR:-default} in a declared value, filled from `env`. */
const fill = (/** @type {string} */ v, /** @type {Record<string, string | undefined>} */ env) =>
  v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name, dflt) => env[name] ?? dflt ?? '');

/**
 * The env a stdio server starts with: what its config declares, PATH and HOME.
 * @param {Record<string, string>} declared @param {Record<string, string | undefined>} [env] this process's
 */
function serverEnv(declared, env = process.env) {
  const out = Object.fromEntries(Object.entries(declared).map(([k, v]) => [k, fill(v, env)]));
  return { ...out, PATH: env.PATH ?? '', HOME: os.homedir() };
}

/**
 * The headers of a streamable HTTP request: the configured ones filled from `env`, then `auth`'s as they are (a
 * credential is never filled), each replacing a configured header of the same name in any case.
 * @param {Record<string, string>} configured @param {Record<string, string>} auth @param {Record<string, string | undefined>} env
 */
function requestHeaders(configured, auth, env) {
  const taken = new Set(Object.keys(auth).map((k) => k.toLowerCase()));
  const filled = Object.entries(configured)
    .filter(([k]) => !taken.has(k.toLowerCase()))
    .map(([k, v]) => [k, fill(v, env)]);
  return { ...Object.fromEntries(filled), ...auth };
}

/**
 * Connects to a server; the caller closes the client. `auth`: what the gateway adds for a managed server's credential
 * (gateway/auth.cjs), on HTTP only; `clientName`: how MoPilot introduces itself to the server.
 * @param {import('./catalog.cjs').StdioLaunch | import('./catalog.cjs').HttpLaunch} launch
 * @param {{ clientName?: string, auth?: import('./auth.cjs').RequestAuth | null }} [o]
 */
async function connectServer(launch, { clientName = 'mopilot-momo', auth = null } = {}) {
  const client = new Client({ name: clientName, version: '1.0.0' });
  const transport =
    launch.type === 'stdio'
      ? new StdioClientTransport({ command: launch.command, args: launch.args, env: serverEnv(launch.env), stderr: 'ignore' })
      : new StreamableHTTPClientTransport(new URL(auth?.url ?? launch.url), {
          requestInit: { headers: requestHeaders(launch.headers, auth?.headers ?? {}, process.env) },
          ...(auth?.fetch ? { fetch: auth.fetch } : {}),
        });
  await client.connect(transport);
  return client;
}

module.exports = { connectServer, serverEnv, requestHeaders };
