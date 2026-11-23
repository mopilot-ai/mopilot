// DEV ONLY: the `momo-late-echo` bench scenario (#4821), kept in a file of its own because scenarios.mjs sits at its size limit; the host adds it to the scenarios createScenarios makes (host.mjs).

/**
 * The fake Mac's MoMo with its send held back: the phone's send is acknowledged at once but the Mac records the line (and starts its
 * turn) only `bench.echoMs` later, as a Mac that reads the line late does, so the phone must keep the person's line on screen meanwhile.
 * @template {{ send: (chatId: string, p: { id: string, text: string }) => Promise<unknown> }} M
 * @param {M} momo
 * @param {{ echoMs?: number }} bench
 * @param {(fn: () => void, ms: number) => unknown} [later]
 * @returns {M}
 */
export function withLateEcho(momo, bench, later = (fn, ms) => /** @type {{ unref?: () => void }} */ (setTimeout(fn, ms)).unref?.()) {
  const send = momo.send;
  momo.send = async (chatId, p) => {
    if (!bench.echoMs) return send(chatId, p);
    later(() => void send(chatId, p), bench.echoMs);
    return null;
  };
  return momo;
}

/**
 * `momo-late-echo [ms|off]`: the Mac takes a MoMo send at once but records the person's line only after `ms` (default 8000).
 * @param {{ echoMs?: number }} bench
 */
export function momoEchoScenario(bench) {
  return {
    usage: 'momo-late-echo [ms|off]',
    about:
      'the Mac takes a message to MoMo at once but records it, and starts MoMo working, only after ms (default 8000): the phone must show your line meanwhile; off is the normal Mac',
    run: (/** @type {string[]} */ [arg = '8000']) => {
      if (arg === 'off') {
        bench.echoMs = 0;
        return 'the Mac records MoMo messages at once';
      }
      const ms = Number(arg);
      if (!Number.isInteger(ms) || ms <= 0) throw new Error('Usage: momo-late-echo [ms|off]');
      bench.echoMs = ms;
      return `the Mac records the next MoMo messages ${ms} ms after taking them`;
    },
  };
}

/**
 * The scenarios with `momo-late-echo` among them.
 * @template {{ list: () => { usage: string, about: string }[], run: (name: string, args?: string[]) => unknown }} S
 * @param {S} scenarios
 * @param {{ echoMs?: number }} bench
 */
export function withMomoEcho(scenarios, bench) {
  const mine = momoEchoScenario(bench);
  return {
    ...scenarios,
    list: () => [...scenarios.list(), { usage: mine.usage, about: mine.about }],
    run: (/** @type {string} */ name, /** @type {string[]} */ args = []) =>
      name === 'momo-late-echo' ? mine.run(args) : scenarios.run(name, args),
  };
}
