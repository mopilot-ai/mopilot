// A message sent with a model or effort (a scheduled task's run, a Host send, Auto's pick) sets them on the ACP session
// first: the select config options of category model and thought_level, before the prompt goes. A value an earlier Auto
// turn left on the session goes back to the chat's own here too, once the session is open (autoRoute/acpRestore.cjs).
const { selectValues } = require('../../../shared/acpMode.mjs');

const CATEGORY = { model: 'model', effort: 'thought_level' };

/**
 * Set the message's model and effort on the chat's session. One the agent doesn't declare, or doesn't offer that value
 * for, stops the message: it would otherwise run on another model than the one asked for.
 * @param {any} host the AcpHost
 * @param {any} chat
 * @param {{ model?: string, effort?: string, restore?: Partial<Record<'model' | 'effort', { own: string, applied: string }>> } | undefined} wanted
 *   restore: what an earlier Auto turn set, set back to the chat's own where this message sets nothing and the session
 *   still runs Auto's value (a value someone picked since is theirs)
 * @param {() => void} [current] throws when the message was stopped or superseded meanwhile
 */
async function applyInitialConfig(host, chat, wanted, current = () => undefined) {
  for (const [what, category] of Object.entries(CATEGORY)) {
    const value = wanted?.[what];
    if (!value) continue;
    const opt = (chat.state?.configOptions ?? []).find((o) => o?.category === category && o.type === 'select');
    const offered = selectValues(opt).find((v) => String(v.value) === value);
    if (!offered) {
      const label = host.label(chat.harness);
      throw new Error(
        opt
          ? `${label} doesn't offer ${what} ${value}; it offers ${selectValues(opt)
              .map((v) => String(v.value))
              .join(', ')}`
          : `${label} declares no ${what} setting, so it can't run on ${value}`,
      );
    }
    if (opt.currentValue === offered.value) continue;
    await host.setConfigOption(chat.key, opt.id, offered.value);
    host.assertChatCurrent(chat);
    current();
  }
  for (const [what, category] of Object.entries(CATEGORY)) {
    const back = wanted?.restore?.[/** @type {'model' | 'effort'} */ (what)];
    if (!back || wanted?.[what]) continue;
    const opt = (chat.state?.configOptions ?? []).find((o) => o?.category === category && o.type === 'select');
    // an agent that no longer offers the chat's own value keeps what it runs
    if (opt?.currentValue !== back.applied || !selectValues(opt).some((v) => String(v.value) === back.own)) continue;
    await host.setConfigOption(chat.key, opt.id, back.own);
    host.assertChatCurrent(chat);
    current();
  }
}

module.exports = { applyInitialConfig };
