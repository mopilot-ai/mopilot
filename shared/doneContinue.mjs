// The one "Done, continue" label and what a browser hand-off tells the agent about it, so the button and every model-facing string agree (#1523, #1834). Pure.

/** "I'm done with the step you handed me, carry on": a sign-in or a step the agent handed over, an app or tab the user took over, a paused desktop, on every surface and harness. */
export const DONE_CONTINUE = 'Done, continue';

/** The user's message "Done, continue" sends on a browser hand-off: it starts the chat's next turn on its current harness. */
export const doneOn = (/** @type {string} */ site) => `Done on ${site}`;

/** How a browser hand-off continues, as the agent is told it: its turn ends, and the user's reply or the button starts the next one. */
export const HANDOFF_CONTINUES = `End your turn now. The chat continues when the user replies or clicks "${DONE_CONTINUE}"; then read the page again.`;
