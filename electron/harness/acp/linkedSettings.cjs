// A linked ACP chat's first prompt inherits a known no-higher native permission mode; later user changes stay the chat's own.
const { latestAcpSessionRecords } = require('../../../shared/acpSessionRecords.mjs');
const { acpModeControl } = require('../../../shared/acpMode.mjs');

const RANK = { readOnly: 0, ask: 1, auto: 2, full: 3 };
const TIER = { plan: 'readOnly', 'read-only': 'readOnly', default: 'ask', 'auto-review': 'auto', 'full-access': 'full' };

/** @param {any} host @param {any} chat @param {string | undefined} permission @param {() => void} [current] */
async function applyLinkedPermission(host, chat, permission, current = () => undefined) {
  if (!permission) return;
  const records = await host.items.readAsync(chat.key);
  host.assertChatCurrent(chat);
  current();
  // Recorded native choices own a chat after its first prompt; a parent's initial cap must not undo a user's later choice.
  if (latestAcpSessionRecords(records).some((r) => r.t === 'user')) return;
  const control = acpModeControl(chat.state);
  if (!control)
    throw new Error('This harness cannot inherit the parent permission safely; choose another harness or change the child permission.');
  const anchors = host.quirksOf(chat.harness)?.anchors ?? {};
  const max = RANK[TIER[permission]];
  const candidates = control.options.filter((mode) => Object.hasOwn(anchors, mode.id) && RANK[anchors[mode.id]] <= max);
  candidates.sort((a, b) => RANK[anchors[b.id]] - RANK[anchors[a.id]]);
  const mode = candidates.find((m) => m.id === control.current) ?? candidates[0];
  if (!mode)
    throw new Error('This harness cannot inherit the parent permission safely; choose another harness or change the child permission.');
  if (mode.id === control.current) return;
  if (control.via === 'mode') await host.setMode(chat.key, mode.id);
  else await host.setConfigOption(chat.key, control.configId, mode.id);
  host.assertChatCurrent(chat);
  current();
}

module.exports = { applyLinkedPermission };
