// The skills Codex lists for a folder on this machine (`skills/list`), for the `/` menu of a chat on it (./hostCommands.mjs): read through the family the Host's sessions built, after its own check that Codex is installed and signed in, so a Codex that cannot run refuses here as a message would.

/**
 * @param {{ running: () => { codex: any, check: () => Promise<void> } | null }} family the factory createCodexFamily returned
 * @param {string | undefined} home the Host's home, the folder asked about when a chat names none
 * @returns {(cwd?: string) => Promise<any>}
 */
export const codexSkills = (family, home) => async (cwd) => {
  const running = family.running();
  if (!running) throw new Error('Codex has not started.');
  await running.check();
  const dir = cwd ?? home;
  return running.codex.request('skills/list', { cwds: dir ? [dir] : [] });
};
