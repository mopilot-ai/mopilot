// DEV ONLY: the bench scenario that puts a routine's report in MoMo's own chat (run from the host console), kept apart from scenarios.mjs.

/** `momo-report [done|failed|setup|off]`: a routine's report or the setup greeting as the Mac sends it; `need` gives the host's controls once they exist. */
export function momoReportScenario(/** @type {() => { momoReport: (shape: string) => Promise<string> }} */ need) {
  return {
    usage: 'momo-report [done|failed|setup|off]',
    about:
      'a routine’s report lands in MoMo’s chat as the Mac sends it: a routine that finished (the default) or did not (failed), or the setup greeting (setup); the phone must draw a one-line card, never MoMo’s instruction to the model. off takes them out',
    run: (/** @type {string[]} */ [shape = 'done']) => need().momoReport(shape),
  };
}
