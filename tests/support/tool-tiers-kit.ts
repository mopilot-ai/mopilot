// Shared fixture for the tool-tier tests (electron/capabilities/mcp/toolTiers.cjs): a Registry with the real browser, Chrome,
// desktop and app specs (handlers that record their calls), ToolSessions, and requests through the shared channel handler.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const { Registry } = require('../../electron/capabilities/contract/registry.cjs');
export const { ToolSessions } = require('../../electron/capabilities/contract/session.cjs');
export const { answerToolRequest, ToolSocket } = require('../../electron/capabilities/mcp/socket.cjs');
export const tiers = require('../../electron/capabilities/mcp/toolTiers.cjs');
const { createBrowserTools } = require('../../electron/capabilities/browser/hostTools.cjs');
const { createChromeTools } = require('../../electron/capabilities/browser/chromeTools.cjs');
const desktop = require('../../electron/capabilities/tools/desktopSpecs.cjs');
const apps = require('../../electron/capabilities/tools/appScopedSpecs.cjs');
const scripts = require('../../electron/capabilities/tools/appScopedScript.cjs');
const preview = require('../../electron/capabilities/browser/devPreview/tools.cjs');

/** Every real browser, Chrome, desktop and app tool spec, as Registry.register takes it (no handler). */
export function realSpecs(): any[] {
  const stub = { tabs: { list: () => [] }, grants: {} };
  const pv = Array.isArray(preview.SPECS)
    ? preview.SPECS
    : Object.entries(preview.SPECS).map(([name, s]: [string, any]) => ({ name, ...s }));
  return [
    ...createBrowserTools(stub),
    ...createChromeTools(stub),
    ...desktop.SPECS,
    ...apps.SPECS,
    ...scripts.SCRIPT_SPECS,
    ...pv.map((s: any) => ({ ...s, schema: s.schema || s.inputSchema })),
  ].map((t: any) => ({ name: t.name, description: t.description, schema: t.schema, policy: t.policy }));
}

/** A Registry with every real spec; each call is recorded in `calls` and answers "ran <name>". */
export function world() {
  const registry = new Registry();
  const calls: { name: string; args: any; chatId: string; segmentId: string }[] = [];
  for (const s of realSpecs())
    registry.register({
      ...s,
      authorizesItself: true,
      handler: async (args: any, ctx: any) => {
        calls.push({ name: s.name, args, chatId: ctx.chatId, segmentId: ctx.segmentId });
        return `ran ${s.name}`;
      },
    });
  const sessions = new ToolSessions();
  // the socket main runs: a turn retiring commits each tiered session's loaded groups (it is never listened on here)
  const sock = new ToolSocket({ sessions, registry });
  let id = 0;
  /** A request on session `key` through the shared handler (sage-mcp's socket and the http channel both use it). */
  const ask = async (key: string, method: string, params: any = {}) => {
    const msg = { jsonrpc: '2.0', id: ++id, method, params };
    return answerToolRequest({ registry, sessions, session: sessions.get(key), calls: new Map(), msg });
  };
  const list = async (key: string) => ((await ask(key, 'tools/list')) as any).result.tools.map((t: any) => t.name) as string[];
  const call = async (key: string, name: string, args: any = {}) =>
    ((await ask(key, 'tools/call', { name, arguments: args })) as any).result;
  return { registry, sessions, sock, calls, ask, list, call };
}

/** The text of an MCP CallToolResult. */
export const textOf = (r: any) => r.content.map((c: any) => c.text).join('\n');
/** The size of a tools/list answer as the model gets it: its JSON, in characters. */
export const listChars = (tools: any[]) => tools.reduce((n, t) => n + JSON.stringify(t).length, 0);
