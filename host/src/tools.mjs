// The Host's tool channel for ACP harnesses: the same ToolSessions, Registry, ToolSocket and SessionMcp the app runs (electron/capabilities), with the portable sage-mcp (./sageMcpShim.mjs) as the stdio server a chat's session is given. A chat's harness may call only the tools registered here, over a socket that accepts a process only when its token is live and the kernel says the harness started it; the socket is opened when the first chat needs it, never at startup.
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createToolRelay } from './toolRelay.mjs';

const require = createRequire(import.meta.url);
const { ToolSessions } = require('../../electron/capabilities/contract/session.cjs');
const { Registry } = require('../../electron/capabilities/contract/registry.cjs');
const { ToolSocket } = require('../../electron/capabilities/mcp/socket.cjs');
const { SessionMcp } = require('../../electron/capabilities/channels/sessionMcp.cjs');
const { peerCheckReady } = require('../../electron/capabilities/mcp/sageMcpReady.cjs');

/** The portable sage-mcp a harness starts (`node <this>`), next to this Host's code. */
const SHIM = fileURLToPath(new URL('../bin/sage-mcp.mjs', import.meta.url));

/**
 * Without a peer check (no Rust core) there are no tools: chats then run without them and `status` says why.
 * @param {object} [o]
 * @param {Parameters<typeof peerCheckReady>[0]} [o.addon]
 * @param {(registry: InstanceType<typeof Registry>) => void} [o.register] adds the tools harnesses may call
 * @param {number} [o.admissionMs] how long a chat waits for its sage-mcp to say hello
 * @param {number} [o.relayTimeoutMs] how long a relayed call waits for the app
 * @param {Parameters<typeof createToolRelay>[0]['audit']} [o.audit] the audit record's `tool.relayed` lines
 * @param {Parameters<typeof createToolRelay>[0]['intents']} [o.intents] the record of calls sent and not answered (./callIntents.mjs)
 */
export function createHostTools({ addon, register, admissionMs, relayTimeoutMs, intents, audit } = {}) {
  if (!peerCheckReady(addon))
    return { available: /** @type {false} */ (false), mcp: null, sessions: null, registry: null, relay: null, close: () => undefined };
  const sessions = new ToolSessions();
  // no approver: a tool that acts or cannot be undone is refused until the Host has a way to ask the person
  const registry = new Registry();
  register?.(registry);
  const relay = createToolRelay({ registry, timeoutMs: relayTimeoutMs, intents, audit });
  const socket = new ToolSocket({ sessions, registry });
  const mcp = new SessionMcp({ sessions, socket, command: process.execPath, args: [SHIM], admissionMs });
  return {
    available: /** @type {true} */ (true),
    /** What AcpHost takes as `tools`: prepare, admission and end for each chat's session. */
    mcp,
    sessions,
    registry,
    /** What the protocol takes as `tools`: the app's tools, relayed. */
    relay,
    close: () => socket.close(),
  };
}
