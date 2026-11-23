// start_session's harness: a linked session runs on its parent's current harness, and another one the agent passed
// stands only when the user's own words this turn pick it (#2084), as Claude Desktop starts its sessions elsewhere only
// where the user names the place. One set aside is said in the start's result.
const { namesHarness, userChoice } = require('../userWords.cjs');

/**
 * The start's arguments with the harness it may run on, and why the agent's choice was set aside (or null).
 * @template {{ harness: string | null }} A
 * @param {{ o: { said?: (chatId: string) => string, controller: { ref: (chatId: string) => { kind: string } } } }} orch
 * @param {string} parentId
 * @param {A} args checked start arguments (spawn.cjs startArgs)
 * @returns {{ args: A, ignored: string | null }}
 */
function ownHarness(orch, parentId, args) {
  // "auto" is main's pick from what the piece needs and what each harness has left (autoHarness.cjs), not the agent's
  if (args.harness === 'auto') return { args, ignored: null };
  const said = orch.o.said?.(parentId) ?? '';
  const own = orch.o.controller.ref(parentId).kind;
  const { value, ignored } = userChoice({
    chosen: args.harness,
    own,
    named: (kind) => namesHarness(said, kind),
    what: 'harness',
    instead: `it runs on this chat's harness, ${own}`,
  });
  return { args: { ...args, harness: value }, ignored };
}

/**
 * The start's result, saying a harness was set aside; with none set aside, the result itself (a repeated call in one
 * turn keeps answering with the same promise).
 * @template T
 * @param {Promise<T>} result
 * @param {string | null} ignored
 */
const noted = (result, ignored) => (ignored ? result.then((r) => ({ ...r, harness_ignored: ignored })) : result);

module.exports = { ownHarness, noted };
