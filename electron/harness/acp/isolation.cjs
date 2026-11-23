// An ACP chat kept apart from the coding side (MoMo's, #2139, #2278): it runs on a process of its own, one per chat (an
// agent may share the MCP servers of every session it holds, #2302), that the harness's isolation quirk confines (its
// own tools and instructions off), told it has no client files or terminal, on the mode the quirk names (no other can be
// picked), every native permission request refused without a card. A harness with no isolation quirk can't be confined
// (its tools run inside its own process, where the client can't see them), so it runs no isolated chat.

/** What an isolated chat's process is told the client offers: no files, no terminal. */
const ISOLATED_CAPABILITIES = Object.freeze({ fs: Object.freeze({ readTextFile: false, writeTextFile: false }), terminal: false });

/**
 * Why a harness can't run an isolated chat, or null when its quirks confine it.
 * @param {any} q the harness's quirks
 */
const unconfined = (q) =>
  q?.isolation ? null : `${q?.label ?? 'This harness'} can't run MoMo's chats: its own file and shell tools can't be turned off`;

/**
 * The answer to a native permission request in an isolated chat: refused (its reject option, else cancelled).
 * @param {{ optionId: string, kind: string }[] | undefined} options
 */
function refusal(options) {
  const o = (options ?? []).find((x) => x.kind === 'reject_once') ?? (options ?? []).find((x) => String(x.kind).startsWith('reject'));
  return o ? { outcome: { outcome: 'selected', optionId: o.optionId } } : { outcome: { outcome: 'cancelled' } };
}

/**
 * Refuse a change that moves an isolated chat off its pinned mode (setMode, or the config option that is its mode).
 * @param {{ isolated?: boolean }} chat
 * @param {{ mode?: string, configOption?: string, value?: unknown } | null | undefined} pin the quirk's isolation.mode
 * @param {{ modeId?: string, configId?: string, value?: unknown }} change
 */
function guardSetting(chat, pin, change) {
  if (!chat.isolated) return;
  const ok =
    change.modeId !== undefined
      ? !!pin?.mode && pin.mode === change.modeId
      : !!pin && (change.configId !== pin.configOption || change.value === pin.value);
  if (!ok) throw new Error("MoMo's chats keep their own mode");
}

/**
 * Put an isolated chat's session on its pinned mode, recorded in its transcript; throws (the session doesn't open)
 * when the agent has no such mode or refuses it.
 * @param {any} host the AcpHost
 * @param {any} chat its state read from the session's answer
 * @param {{ mode?: string, configOption?: string, value?: unknown }} pin
 */
async function holdPin(host, chat, pin) {
  const st = chat.state;
  if (pin.mode) {
    if (st.modes?.currentModeId === pin.mode) return;
    await chat.agent.request('session/set_mode', { sessionId: chat.sessionId, modeId: pin.mode });
    st.modes = { ...st.modes, currentModeId: pin.mode };
    host.items.append(chat.key, { t: 'mode', modeId: pin.mode, at: host.now() });
    return;
  }
  const opt = (st.configOptions ?? []).find((/** @type {any} */ o) => o.id === pin.configOption);
  if (!opt) throw new Error(`${host.label(chat.harness)} has no ${pin.configOption} mode for MoMo's chats`);
  if (opt.currentValue === pin.value) return;
  const res = await chat.agent.request('session/set_config_option', {
    sessionId: chat.sessionId,
    configId: pin.configOption,
    value: pin.value,
  });
  // an agent that answers without the options has taken the value all the same
  st.configOptions = Array.isArray(res?.configOptions)
    ? res.configOptions
    : st.configOptions.map((/** @type {any} */ o) => (o.id === pin.configOption ? { ...o, currentValue: pin.value } : o));
  host.items.append(chat.key, { t: 'config', configId: pin.configOption, value: pin.value, at: host.now() });
}

module.exports = { ISOLATED_CAPABILITIES, unconfined, refusal, guardSetting, holdPin };
