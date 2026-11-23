// Opens the MCP gateway in main (#2999 C2, C3, electron/gateway): its store under `<userData>/gateway`, its managed servers started, their tools offered to every chat that isn't MoMo's through the tool Registry under the user's rules (gateway/policy.cjs: the chat's harness and permission mode from main's session settings, its folder from its harness), each ask on the chat's own card (kind gatewayTool, so every window shows it), each harness's own copies of its servers switched off (C4), and Settings told when anything changed. Nothing here needs a window.
const { Gateway, gatewayDir } = require('../gateway/service.cjs');
const { GatewayOffer } = require('../gateway/offer.cjs');
const { GatewayPolicy } = require('../gateway/policy.cjs');
const { createSessionSettings } = require('./sessionSettings.cjs');
const { ownerOf } = require('../platform/segmentOwner.cjs');
const { isMomoMeta } = require('../../shared/momoChat.mjs');
const { pluginDelivery } = require('../plugins/service.cjs');
const { noteIgnored } = require('../ignored.cjs');

/**
 * @param {{ live: any, userData: string, safeStorage: any, broadcastAll: (channel: string, ...args: any[]) => void,
 *   quitSignal: AbortSignal, prefs?: () => Record<string, any>, projectOf: (chatId: string) => Promise<string | null> }} o
 *   prefs: the user's settings (a Codex chat's default permission); projectOf: the chat's folder (session/chatProject.cjs)
 * @returns {InstanceType<typeof Gateway>}
 */
function openGateway({ live, userData, safeStorage, broadcastAll, quitSignal, prefs = () => ({}), projectOf }) {
  const gateway = new Gateway({ dir: gatewayDir(userData), safeStorage });
  const settings = createSessionSettings({ live, prefs });
  const policy = new GatewayPolicy({
    // a rule "Always allow" writes goes through the gateway, so every window hears it
    rules: { view: () => gateway.rules.view(), add: (rule) => gateway.addRule(rule) },
    chatOf: (chatId) => {
      try {
        const s = settings.settingsOf(chatId);
        const worktreeOf = live.chats?.records.get(chatId)?.meta?.worktreeOf ?? null;
        return s ? { harness: s.kind, fullAccess: s.permission === 'full-access', worktreeOf } : null;
      } catch (error) {
        // a chat whose settings can't be read is not Full access
        noteIgnored("read a chat's permission for the gateway's rules", error);
        return null;
      }
    },
    projectOf,
  });
  gateway.on('changed', () => broadcastAll('gateway:changed'));
  // C4: each harness switches off its own copies of the servers the gateway runs (Claude through agentTools.cjs's
  // gatewayDenials): Codex per thread, a basic harness per process (restarted when the managed set changes), and the
  // plugins' servers an ACP session would get
  const managed = (/** @type {unknown} */ entry) => gateway.isManagedNative(entry);
  const managedSet = () => JSON.stringify([...gateway.managedKeys()].sort());
  if (live.codexTools) Object.assign(live.codexTools, { managedServer: managed, managedSig: managedSet });
  if (live.acpOwnMcp) {
    live.acpOwnMcp.managed = managed;
    live.acpOwnMcp.changed(managedSet());
    gateway.on('changed', () => live.acpOwnMcp.changed(managedSet()));
  }
  pluginDelivery().managed = managed;
  if (live.capabilities) {
    const offer = new GatewayOffer({
      upstreams: gateway.upstreams,
      registry: live.capabilities,
      owner: (ctx) => ownerOf(live.chats?.records, ctx),
      // MoMo's chats keep to MoMo's own tools (electron/momo/contract/toolIsolation.cjs)
      visible: (chatId) => !isMomoMeta(live.chats?.records.get(chatId)?.meta),
      policy,
      ask: async (chatId, signal, card) => {
        const broker = live.computerUse?.broker;
        // no card can be shown: no answer, so nothing runs
        if (!broker) return null;
        return broker.ask(chatId, 'gatewayTool', { harness: live.controller.ref(chatId).kind, ...card }, { signal });
      },
    });
    quitSignal.addEventListener('abort', () => offer.close(), { once: true });
  }
  quitSignal.addEventListener('abort', () => gateway.close(), { once: true });
  gateway.sync().catch((error) => noteIgnored("start the gateway's servers", error));
  return gateway;
}

module.exports = { openGateway };
