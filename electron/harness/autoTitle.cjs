// How a new chat's generated title lands on every harness: its own helper writes it at send (Claude Code's beside the CLI's
// start), and it is saved only once the turn started and while the chat still carries the provisional name (a rename wins).

const { clock } = require('../platform/ports/clock.cjs');
const { generatedTitle } = require('../../shared/title.mjs');
const { noteIgnored } = require('../ignored.cjs');

/** The longest a harness's title writer may take before the chat keeps its provisional name. */
const TITLE_MS = 30_000;

/**
 * `p`'s value, or null once `ms` pass first (the work itself is left to finish or fail on its own).
 * @template T
 * @param {Promise<T>} p
 * @returns {Promise<T | null>}
 */
function within(p, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const late = new Promise((resolve) => {
    timer = clock.setTimeout(resolve, ms, null);
    timer.unref?.();
  });
  return /** @type {Promise<T | null>} */ (Promise.race([p, late]).finally(() => clock.clearTimeout(timer)));
}

/**
 * Write and save a chat's title. A writer that fails, times out or answers nothing leaves the title cut from the
 * message; a chat named meanwhile keeps its name.
 * @param {object} o
 * @param {string} o.prompt the chat's first message
 * @param {() => Promise<unknown>} o.generate the harness's title writer: its raw reply, or null
 * @param {() => Promise<boolean> | boolean} o.unnamed the chat still has only its provisional name (asked after writing)
 * @param {(name: string) => Promise<unknown> | unknown} o.apply saves the title where the harness keeps it
 * @param {string} o.what what failed, for noteIgnored
 * @param {number} [o.ms] how long the writer may take
 * @param {Promise<boolean>} [o.accepted] whether the turn the title was written beside started (default: it had)
 * @returns {Promise<string | null>} the title saved, or null when the chat had been named or its turn didn't start
 */
async function landTitle({ prompt, generate, unnamed, apply, what, ms = TITLE_MS, accepted }) {
  const raw = await within(Promise.resolve().then(generate), ms).catch((error) => (noteIgnored(what, error), null));
  const name = generatedTitle(typeof raw === 'string' ? raw : null, prompt);
  if (accepted && !(await accepted)) return null;
  if (!(await unnamed())) return null;
  await apply(name);
  return name;
}

module.exports = { landTitle, within, TITLE_MS };
