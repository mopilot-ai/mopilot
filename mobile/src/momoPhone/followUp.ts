// What the store does after the home has answered an intent whose effect arrives later: a machine that does not change in time says so.

/** The intents whose result is a machine changing: it wakes, updates, signs in, installs. */
export const SLOW_KINDS: ReadonlySet<string> = new Set(['wake', 'update-machine', 'sign-in-agent', 'install-agent']);
/** How long a machine has to change before the phone says it has not. */
export const NO_CHANGE_MS = 10_000;
