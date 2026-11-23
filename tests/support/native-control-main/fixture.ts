// Main-process side of native computer and browser control (PR #346 and #347): Codex's per-thread
// control path (native / managed / helper) and the in-app browser note
// (capabilities/channels/codexConfig.cjs), the vendor plugin's turn cleanup
// (capabilities/contract/codexLifecycle.cjs), what a session may see over sage-mcp
// (capabilities/contract/session.cjs, capabilities/mcp/socket.cjs), the cua_repl elicitation gate
// (capabilities/contract/serverRequests.cjs) and the Claude SDK servers' hide filter (capabilities/mcp/sdkMcp.cjs).
// The modules are real; the app-server, the harness and the Agent SDK are fakes.
import { createRequire } from 'node:module';
import { tick } from '../async-scenarios.ts';

const require = createRequire(import.meta.url);
export const {
  codexThreadConfig,
  nativeThreadConfig,
  nativeControlOff,
  CodexToolInjection,
  inAppBrowserNote,
  scopeNote,
  NATIVE_CUA_PLUGIN,
  IN_APP_BROWSER_CONTEXT,
} = require('../../../electron/capabilities/channels/codexConfig.cjs');
export const { NativeCodexLifecycle } = require('../../../electron/capabilities/contract/codexLifecycle.cjs');
export const { ToolSessions } = require('../../../electron/capabilities/contract/session.cjs');
export const { chromeSelectionNote } = require('../../../electron/capabilities/browser/codexChromePick.cjs');
export const { ToolSocket } = require('../../../electron/capabilities/mcp/socket.cjs');
export const { rejectNativeCuaElicitation } = require('../../../electron/capabilities/contract/serverRequests.cjs');
export const { hideRule } = require('../../../electron/capabilities/visibility.cjs');
export const {
  sdkMcpServer,
  sdkMcpServers,
  injectSdkMcp,
  injectSdkMcpServers,
  readOnlyAllowedTools,
  autoAllow,
} = require('../../../electron/capabilities/mcp/sdkMcp.cjs');

export const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

export function injection(o: any = {}) {
  const sessions = new ToolSessions();
  const inj = new CodexToolInjection({ sessions, command: '/bin/sage-mcp', socketPath: '/s.sock', harnessPid: () => 7, ...o });
  const server = (msg: any) => Object.keys(msg.params.config.mcp_servers).find((n) => n.startsWith('sage_')) ?? null;
  return { sessions, inj, server };
}

export function lifecycle(o: any = {}) {
  const native = new Set<string>(o.native ?? ['th']);
  const calls: any[] = [];
  const states: any[] = [];
  const errors: any[] = [];
  const blocked: any[] = [];
  const timings: any[] = [];
  const sky: any[] = [];
  let clock = 1_000;
  let respond: (method: string, params: any, timeout: number) => any = o.respond ?? (() => ({ content: [] }));
  const lc = new NativeCodexLifecycle({
    call: async (method: string, params: any, timeout: number) => {
      calls.push({ tool: params.tool, args: params.arguments, timeout, threadId: params.threadId, server: params.server, method });
      return respond(method, params, timeout);
    },
    isNativeThread: (id: string) => native.has(id),
    ...(o.defaults
      ? {}
      : {
          onError: (id: string, e: Error) => errors.push([id, e.message]),
          onState: (id: string, s: any) => states.push([id, s]),
          onBlocked: (id: string, turnId: string, text: string) => blocked.push([id, turnId, text]),
          onTiming: (t: any) => timings.push(t),
          onSkyProblem: (id: string, p: any) => sky.push([id, p.kind, p.message]),
          now: () => clock,
        }),
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
    ...(o.endTimeoutMs ? { endTimeoutMs: o.endTimeoutMs } : {}),
  });
  return {
    lc,
    native,
    calls,
    states,
    errors,
    blocked,
    timings,
    sky,
    advance: (ms: number) => (clock += ms),
    setRespond: (f: typeof respond) => (respond = f),
  };
}
export const item = (method: string, turnId: string, tool = 'js', id = 'i1', threadId = 'th', extra: any = {}) => ({
  method,
  params: { threadId, turnId, item: { type: 'mcpToolCall', server: 'cua_repl', tool, id, ...extra } },
});
export const done = (turnId: string, status = 'completed', threadId = 'th') => ({
  method: 'turn/completed',
  params: { threadId, turn: { id: turnId, status } },
});
export const hookOf = (c: any) => [c.tool, c.args?.hook_event_name ?? null, c.args?.session_id ?? null, c.args?.turn_id ?? null];
export { deferred, tick } from '../async-scenarios';

export const started = (id: string, extra: any) => ({ method: 'thread/started', params: { thread: { id, ...extra } } });

export function fakeRegistry(names: string[]) {
  const invoked: any[] = [];
  return {
    invoked,
    list: () =>
      names.map((name) => ({
        name,
        description: `about ${name}`,
        inputSchema: { type: 'object', properties: {} },
        policy: name.endsWith('_read') ? 'observe' : 'act',
      })),
    invoke: async (chatId: string, segmentId: string, name: string, args: any, o?: any) => {
      invoked.push({ chatId, segmentId, name, args, callId: o?.callId ?? null });
      return { ok: true, content: [{ type: 'text', text: `ran ${name}` }] };
    },
  };
}
