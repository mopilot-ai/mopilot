// What a session's model is told about its task list and wrap-up box, on every harness, as Claude Desktop's system prompt
// tells it ("Task list and wrap-up"): the list rides with the turn's first tool call, is sent again after each message
// from the user, and the turn closes with wrap_up. Sent only to a session shown update_task_list.

/**
 * The "Task list and wrap-up" note, or null when the session is not shown update_task_list.
 * @param {string[]} names the Registry tools the session is shown
 * @param {{ name: (registryName: string) => string }} [naming] the names as this session sees them
 * @returns {string | null}
 */
function turnBoxNote(names, naming = { name: (n) => n }) {
  if (!names.includes('update_task_list')) return null;
  const list = naming.name('update_task_list');
  const wrap = names.includes('wrap_up') ? naming.name('wrap_up') : null;
  // both wait behind the tool search on every harness (G11): a browse-only turn never pays for their schemas
  const load = wrap ? `${list} and ${wrap}` : list;
  const lines = [
    'Task list and wrap-up (this app):',
    `- The user follows your progress on the task list under your latest message, not by reading your messages, so keeping it is part of the task. ${list} is that list: use it in place of a plan or todo tool of your own.`,
    `- ${load} ${wrap ? 'wait' : 'waits'} behind the tool search. For a request that edits files or runs more than one command, load ${wrap ? 'them' : 'it'} with your first tool call, then send ${list} with the whole plan in the same message as your next tool call; as each step finishes, {"advance": true} rides along with the call that starts the next one. A question answered only by reading or browsing needs neither.`,
    `- Each message from the user, a new request or a word mid-task, gets its list: send ${list} with the whole list for it alongside your first tool call after it, even when the plan is unchanged.`,
  ];
  if (wrap)
    lines.push(
      `- Every turn in which you kept a task list, changed files or ran commands closes with ${wrap}, when the work is done and before any closing message.`,
    );
  return lines.join('\n');
}

module.exports = { turnBoxNote };
