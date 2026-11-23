// DEV ONLY: the bench scenario that puts a question with answer chips in MoMo's chat (run from the host console), kept apart from scenarios.mjs.

/** `momo-options [on|off]`: a question whose reply row carries `options`; `need` gives the host's controls once they exist. */
export function momoOptionsScenario(/** @type {() => { momoOptions: (shape: string) => Promise<string> }} */ need) {
  return {
    usage: 'momo-options [on|off]',
    about:
      'MoMo asked a question with answer chips: its last reply is the question and carries options Yes, No and Not now (on, the default), or take those questions out of the chat (off)',
    run: (/** @type {string[]} */ [shape = 'on']) => need().momoOptions(shape),
  };
}
