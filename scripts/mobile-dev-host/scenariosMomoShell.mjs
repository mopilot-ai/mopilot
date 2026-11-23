// DEV ONLY: the `momo-shell` bench scenario (MoMo's page shell, M0b), kept in a file of its own because scenarios.mjs sits at its size limit; the host adds it to the scenarios createScenarios makes (host.mjs) instead of editing that list.

/**
 * `momo-shell [on|off]`: the Mac says in its MoMo state that its page shell is on (on, the default), so the phone draws Chat · Tasks · Files, or that it is
 * off or an older Mac (off), so the phone is the chat alone. The Tasks tab comes with the four-tab panel, which the dev host's Mac always has on.
 * @param {{ shell?: boolean }} bench
 * @param {(area: 'prefs') => void} changed tells the phones MoMo's settings changed, so the open page reads its state again
 */
export function momoShellScenario(bench, changed) {
  return {
    usage: 'momo-shell [on|off]',
    about:
      'the Mac says its MoMo page shell is on (on, the default): the phone draws Chat · Tasks · Files under MoMo; off is an older Mac or the flag off: the chat alone',
    run: (/** @type {string[]} */ [arg = 'on']) => {
      const word = arg.toLowerCase();
      if (word !== 'on' && word !== 'off') throw new Error('Usage: momo-shell [on|off]');
      bench.shell = word === 'on';
      changed('prefs');
      return `the Mac's MoMo shell is ${word}: the open MoMo page reads it at once${bench.shell ? ' (Tasks needs momo-tasks on, which is the default)' : ''}`;
    },
  };
}

/**
 * The scenarios with `momo-shell` among them.
 * @template {{ list: () => { usage: string, about: string }[], run: (name: string, args?: string[]) => unknown }} S
 * @param {S} scenarios
 * @param {{ shell?: boolean }} bench
 * @param {(area: 'prefs') => void} changed
 */
export function withMomoShell(scenarios, bench, changed) {
  const mine = momoShellScenario(bench, changed);
  return {
    ...scenarios,
    list: () => [...scenarios.list(), { usage: mine.usage, about: mine.about }],
    run: (/** @type {string} */ name, /** @type {string[]} */ args = []) =>
      name === 'momo-shell' ? mine.run(args) : scenarios.run(name, args),
  };
}
