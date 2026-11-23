// The prompts every arm gets, word for word the same per benchmark apart from naming the arm's browser, with the
// fairness rules (GUI only: no shell, no scripts, no page source) and a run tag that finds the turn's transcript.

const NO_SHELL_WEB = 'Use the GUI only: do not run shell commands or scripts, and do not read the page source.';

/** The setup URL that starts a REAL task's state on its site. @param {{ id: string, url: string }} t */
export const realConfigUrl = (t) => `${t.url}/config?run_id=0&task_id=v2.${t.id}&latency=0&removePopup=true`;

/** @param {{ description: string, path: string }} t @param {string} base @param {string} browser */
export function webGamesPrompt(t, base, browser) {
  return (
    `Use ${browser}. Your task is: ${t.description}. You must go to ${base}/${t.path} and obtain the password for the game. ` +
    'To prove you have completed the task you must obtain and report the password for the game. If you do not have the password, you have not managed to complete the task. ' +
    'Use the GUI only: play the game through the page itself; do not run shell commands or scripts, and do not read the page source.'
  );
}

/**
 * A REAL task. When the driver set the site up in the arm's browser (`preopened`), the agent starts on it; otherwise
 * (a desktop app the driver cannot reach into) the agent opens the two setup pages itself, which adds two
 * navigations to its wall time, and keeps the tab open so /finish can be read afterwards.
 * @param {{ id: string, url: string, goal: string }} t @param {string} browser @param {boolean} preopened
 */
export function realPrompt(t, browser, preopened) {
  if (preopened) {
    return (
      `Use ${browser}. The website ${t.url}/ is a sandbox clone for testing (no real accounts, payments or people) and is already open in ${browser}. Task: ${t.goal}\n` +
      `Complete the task on that website. ${NO_SHELL_WEB} Reply DONE when finished.`
    );
  }
  return (
    `Use ${browser}. The website ${t.url}/ is a sandbox clone for testing (no real accounts, payments or people). ` +
    `First open these two setup pages in that browser, one after the other: ${realConfigUrl(t)} and then ${t.url}/finish . ` +
    `Then open ${t.url}/ in the same tab and do this task: ${t.goal}\n${NO_SHELL_WEB} Leave the site's tab open when you finish. Reply DONE when finished.`
  );
}

/** @param {{ instruction: string }} t */
export function macPrompt(t) {
  return (
    `Use computer use to operate this Mac's apps through their GUI. Task: ${t.instruction}\n` +
    'Use the GUI only: do not run shell commands, scripts or AppleScript/osascript, and do not edit files directly. Reply DONE when finished.'
  );
}

/** A tag unique to one task run, appended to the prompt so the turn's transcript can be found. */
export const runTag = (/** @type {string} */ arm, /** @type {string} */ id, now = Date.now()) => `bench-${arm}-${id}-${now.toString(36)}`;

/** The prompt as sent: the operator's extra instruction, if any, and the run tag. */
export const finalPrompt = (/** @type {string} */ prompt, /** @type {string} */ extra, /** @type {string} */ tag) =>
  `${prompt}${extra ? ` ${extra}` : ''} (run tag: ${tag})`;
