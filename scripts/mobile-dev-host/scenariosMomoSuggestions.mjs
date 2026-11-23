// DEV ONLY: the bench scenario for MoMo's suggestions (A7), kept apart from scenariosMomo.mjs.

/**
 * `momo-suggestions [on|off|empty]`: the Mac lists momo.suggestions.list and .act with three made-up suggestions in Up next (on, the default),
 * is an older Mac that lists neither (off), or lists them with none (empty).
 * @param {() => { momoSuggestions: (mode: 'on' | 'off' | 'empty') => Promise<string> | string }} need the host's controls
 */
export function momoSuggestionsScenario(need) {
  const usage = 'momo-suggestions [on|off|empty]';
  return {
    usage,
    about:
      'the Mac lists momo.suggestions.* with three made-up suggestions in Up next (on, the default; Start sends the first step into MoMo’s chat), is an older Mac that does not (off), or lists them with none (empty)',
    run: (/** @type {string[]} */ [arg = 'on']) => {
      if (arg !== 'on' && arg !== 'off' && arg !== 'empty') throw new Error(usage);
      return need().momoSuggestions(arg);
    },
  };
}

/**
 * `momo-brief [on|off|failed]`: the Mac has the morning brief (on: its Scheduled row and its stack of lines and suggestion cards in MoMo's chat),
 * could not start it (failed: "Couldn't start" with its reason and Try again, which writes it), or is a Mac without it (off).
 * @param {() => { momoBrief: (mode: 'on' | 'off' | 'failed') => Promise<string> | string }} need the host's controls
 */
export function momoBriefScenario(need) {
  const usage = 'momo-brief [on|off|failed]';
  return {
    usage,
    about:
      'the Mac has the morning brief: its Scheduled row and its stack in MoMo’s chat (on, the default for the scenario), a brief that could not start, with its reason and Try again (failed), or a Mac without it (off)',
    run: (/** @type {string[]} */ [arg = 'on']) => {
      if (arg !== 'on' && arg !== 'off' && arg !== 'failed') throw new Error(usage);
      return need().momoBrief(arg);
    },
  };
}
