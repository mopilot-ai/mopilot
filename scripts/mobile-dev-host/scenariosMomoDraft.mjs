// DEV ONLY: the bench scenario that puts a draft MoMo wrote in its own chat (run from the host console), kept apart from scenarios.mjs.

/** `momo-draft [one|long|sent|asked|unsure|off]`: a draft MoMo wrote for the user; `need` gives the host's controls once they exist. */
export function momoDraftScenario(/** @type {() => { momoDraft: (shape: string) => Promise<string> }} */ need) {
  return {
    usage: 'momo-draft [one|long|sent|asked|unsure|off]',
    about:
      'MoMo wrote a draft: one for two people (the default) with Edit, Copy and Open in Mail, a long one that Copy takes but a mail link cannot (long), a draft the user already sent from the Mac, read only (sent, asked or unsure), or take the drafts out of the chat (off). Nothing sends',
    run: (/** @type {string[]} */ [shape = 'one']) => need().momoDraft(shape),
  };
}
