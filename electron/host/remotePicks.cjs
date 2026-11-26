// Freezes machine-scoped model and permission choices before a remote message enters its durable outbox.
const { parseKind } = require('../../shared/harnessKind.mjs');
const { hostFamilyOfHarness } = require('../../shared/host/chatIds.mjs');
const { hostPermissionOf, isHostPermission, hostPermissionFamily, startingHostMode } = require('../../shared/host/permissions.mjs');
/** @param {{ chatId: string, hostId: string, opts: any, model?: unknown, permission?: unknown, chat?: { permission?: string | null, pendingSwitch?: unknown }, item?: { followUp?: string }, kind?: string, planOk?: (harness: string) => boolean, userDefault?: string, starting?: boolean }} o `starting`: the chat's first message starts it here (this Mac's default mode is for that only); `planOk`: whether the machine's Host says it takes Plan for this agent (`planMode` on the agent's row); `userDefault`: this Mac's default permission, the mode a chat with no pick and no mode of its own starts in */
function remotePicks({ chatId, hostId, opts, model, permission, chat, kind, item, planOk = () => false, userDefault, starting = true }) {
  const { hostSelection, hostPermission, hostMode: _unscoped, hostBase: _base, ...kept } = opts;
  const basic = /^acp:([^:]+):/.exec(chatId)?.[1] ?? '';
  const parsed = parseKind(kind);
  const source = (parsed?.family === 'acp' ? parsed.basic : parsed?.family) || basic;
  const harness = hostFamilyOfHarness(source) ?? (source || (chatId.startsWith('claude:') ? 'claude' : 'codex'));
  const pick = hostSelection ?? model;
  if (!kept.model && typeof pick?.model === 'string' && pick.model && pick.hostId === hostId && pick.harness === harness)
    Object.assign(kept, { model: pick.model, ...(pick.effort ? { effort: pick.effort } : {}), ...kept });
  const picked = hostPermissionOf(hostPermission ?? permission, hostId, harness);
  const mode =
    picked ??
    (isHostPermission(chat?.permission)
      ? chat.permission
      : // this Mac's default is where a chat STARTS: one that already runs on its Host keeps the mode the Host reports until a pick here
        starting && (hostPermissionFamily(source) || (!parsed && chatId.startsWith('claude:')))
        ? startingHostMode({ hostId, harness, macDefault: userDefault })
        : null);
  // a message with Plan on asks a Host that takes it to hold Plan; one the Host does not take for this agent keeps `plan`, and the send refuses it with its words
  const planned = !!kept.plan && planOk(harness);
  if (planned) delete kept.plan;
  // Plan runs its tools on the mode the person had picked: it rides with the message, entered on the Host before Plan
  const out = {
    ...kept,
    ...(planned ? { hostMode: 'plan', ...(picked ? { hostBase: picked } : {}) } : mode ? { hostMode: mode } : {}),
  };
  // into the running turn on the Host, as on This Mac, where the person chose steer and the agent takes it
  if (steersInto({ item, kind, opts: out, held: chat?.pendingSwitch })) out.steer = true;
  return out;
}
const { agentTraitsOf } = require('../harness/family.cjs');
/** Whether a message sent while a turn runs goes into it on the machine's Host, by the rule This Mac steers by (controller.send): the person chose steer, the agent takes it, and it carries no Plan, goal or compaction and the chat has no held switch. @param {{ item: any, kind: string | undefined, opts: any, held: unknown }} o */
function steersInto({ item, kind, opts, held }) {
  // a machine's Claude Code or Codex chat is `acp:host-claude` / `acp:host-codex` in this app and `claude` / `codex` there: the agent it runs decides (the chat's `steer` capability reads the same trait, electron/harness/bindings.cjs)
  return (
    item?.followUp === 'steer' &&
    agentTraitsOf(kind)?.steers === true &&
    !opts.compact &&
    !opts.plan &&
    !opts.goal &&
    opts.hostMode !== 'plan' &&
    !held
  );
}
/** This Mac's default permission mode, read from the app's state each time a message is kept (it may change in Settings). @param {(() => { prefs?: { permission?: string } } | undefined) | undefined} readState */
const macDefaultOf = (readState) => () => readState?.()?.prefs?.permission;
/**
 * What `remotePicks` is asked for a message kept for a chat on a machine, from what the sender knows of the chat; `taken` is the adoption of chats taken in from a machine's list (a chat taken in keeps the mode its Host reports, a chat that starts here takes this Mac's default).
 * @param {{ ownerOf: (chatId: string) => { hostId: string }, selectionOf: (chatId: string) => unknown, permissionOf: (chatId: string) => unknown, userDefaultOf: () => string | undefined, taken: () => { takenIn?: (chatId: string) => boolean } | undefined, state: () => { get: (chatId: string) => any }, kindOf: (chatId: string) => string | undefined, rowOf: (hostId: string) => any }} o
 */
const picksFor =
  ({ ownerOf, selectionOf, permissionOf, userDefaultOf, taken, state, kindOf, rowOf }) =>
  (/** @type {string} */ chatId, /** @type {any} */ opts, /** @type {any} */ item, /** @type {boolean} */ beginning) =>
    remotePicks({
      chatId,
      hostId: ownerOf(chatId).hostId,
      opts,
      model: selectionOf(chatId),
      permission: permissionOf(chatId),
      userDefault: userDefaultOf(),
      starting: beginning || !taken()?.takenIn?.(chatId),
      chat: state().get(chatId),
      kind: kindOf(chatId),
      item,
      // the machine's own word, from its last status: the Host takes Plan for this agent
      planOk: (harness) =>
        rowOf(ownerOf(chatId).hostId)?.harnesses?.some((/** @type {any} */ h) => h.id === harness && h.planMode === true) === true,
    });
module.exports = { remotePicks, steersInto, macDefaultOf, picksFor };
