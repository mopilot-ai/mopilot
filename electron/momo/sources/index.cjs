// MoMo's local sources put together (#2139 P2): the hub (state, connect date, access level, decide and audit) and each source over it, the connectors' token vault and hub (#2999), Calendar and Reminders through the macOS helper's EventKit commands and Files on this Mac's disk. The integration PR builds this once in main and hands it to the tools and the Settings IPC.
const { SourcesHub } = require('./hub.cjs');
const { createEventKit } = require('./eventKit.cjs');
const { calendarSource } = require('./calendar.cjs');
const { remindersSource } = require('./reminders.cjs');
const { filesSource } = require('./files.cjs');
const { WriteLedger } = require('./writeLedger.cjs');
const { OutputsStore } = require('../outputs.cjs');
const { createConnectAsk } = require('./connectAsk.cjs');
const { TokenVault } = require('../connectors/vault.cjs');
const { ConnectorHub } = require('../connectors/hub.cjs');
const { fakeConnector } = require('../connectors/fake.cjs');
const { fakeMailConnector, ACCOUNTS: FAKE_MAIL } = require('../connectors/fakeMail.cjs');
const { McpAllowlist } = require('../mcp/allowlist.cjs');
const { McpProxy } = require('../mcp/proxy.cjs');
const { readCatalog } = require('../../gateway/catalog.cjs');

/**
 * @param {{ dir: string, safeStorage: import('./hub.cjs').SafeStorage | null, allowed: () => boolean, decide: import('./hub.cjs').Decide | null,
 *           audit: import('./hub.cjs').Audit | null, helper: import('./eventKit.cjs').Helper | null, home?: string, now?: () => number }} o
 *   helper: the computer-use helper's client (null off macOS)
 * @param {{ decide: import('../connectors/hub.cjs').Decide | null, audit: import('../connectors/hub.cjs').Audit | null,
 *   openExternal: (url: string) => unknown, fake?: boolean, mcp?: Parameters<typeof readCatalog>[0] }} [connectors] the connector hub's
 *   trust layer and the system browser; fake: the test connector (E2E runs only); mcp: where coding chats configure their MCP servers
 */
function createMomoSources({ dir, safeStorage, allowed, decide, audit, helper, home, now }, connectors) {
  const hub = new SourcesHub({ dir, safeStorage, allowed, decide, audit, now });
  const eventKit = createEventKit(helper);
  const calendar = calendarSource({ hub, eventKit, now });
  const reminders = remindersSource({ hub, eventKit });
  const files = filesSource({ hub, home });
  // what MoMo wrote to Calendar and Reminders (#2139 P5), for undo
  const writeLedger = new WriteLedger({ dir, safeStorage, now });
  // the files MoMo saves (#2139 Outputs), kept beside the sources and deleted with them
  const outputs = new OutputsStore({ dir, safeStorage, now });
  // the connectors' tokens (#2999 C0), sealed beside the sources under MoMo's folder
  const connectorVault = new TokenVault({ dir, safeStorage, now });
  // the cloud accounts (#2999 C0): no trust layer wired means every call is refused
  const connectorHub = new ConnectorHub({
    vault: connectorVault,
    allowed,
    decide: connectors?.decide ?? null,
    audit: connectors?.audit ?? null,
    openExternal: connectors?.openExternal ?? (() => Promise.reject(new Error('No browser to open'))),
    now,
  });
  if (connectors?.fake === true) {
    connectorHub.register(fakeConnector({ now }));
    // two fake mail accounts for the draft card's Send: they keep the mail in memory and reach nobody
    for (const who of FAKE_MAIL) connectorHub.register(fakeMailConnector(who, { now }));
  }
  // coding-side MCP servers allowed into MoMo one by one (#2999 C0), through the same trust layer
  const mcpAllowlist = new McpAllowlist({ dir, safeStorage, now });
  const mcp = connectors?.mcp;
  const mcpProxy = new McpProxy({
    catalog: async () => (mcp ? readCatalog(mcp) : []),
    allowlist: mcpAllowlist,
    allowed,
    decide: connectors?.decide ?? null,
    audit: connectors?.audit ?? null,
  });
  return {
    hub,
    eventKit,
    calendar,
    reminders,
    files,
    writeLedger,
    outputs,
    byId: { calendar, reminders, files },
    connectorVault,
    connectorHub,
    mcpAllowlist,
    mcpProxy,
  };
}

/** A connector tool that reads the user's mail (not one that only sends a draft the user pressed Send on). */
const READS_MAIL = /mail|inbox|gmail|message/i;

/**
 * What MoMo can reach now (#5803), for its turn's context: the local sources it may read and the accounts signed in, by
 * name, and whether any of them reads mail. A source macOS refuses, or one whose list can't be read, is left out.
 * @param {{ hub: { list(): { id: string, label: string, connected: boolean, needsGrant?: boolean }[] },
 *   connectorHub: { list(): { label: string, connected: boolean, needsReconnect?: boolean, tools: { name: string, kind: string }[] }[] } }} sources
 * @returns {{ sources: string[], readsMail: boolean }}
 */
function reachableNow({ hub, connectorHub }) {
  const local = hub.list().filter((s) => s.connected && !s.needsGrant);
  const accounts = connectorHub.list().filter((c) => c.connected && !c.needsReconnect);
  return {
    sources: [...local.map((s) => s.label), ...accounts.map((c) => c.label)],
    readsMail: accounts.some((c) => c.tools.some((t) => t.kind === 'read' && READS_MAIL.test(t.name))),
  };
}

module.exports = { createMomoSources, createConnectAsk, reachableNow };
