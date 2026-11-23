// What a session's model is told about starting other sessions (linked MoPilot chats), on every harness: one paragraph that sends it to start_session's description, which carries the rules (SESSION_RULES: when to start, offer or propose one, hand a task off, link a session in a reply, show one beside it in split view, and what never to do: poll, merge or archive without the user's word). How to fill start_session's fields (worktree, fresh or fork, harness, after) is that description's too.
// Sent only to a session shown start_session. withSessionsNote joins MoPilot's model notes: the surface note
// (surfaceNote.cjs), the task-list note (turnBoxNote.cjs), artifact and design-system notes, and this one.

const { artifactNote } = require('./artifactNote.cjs');
const { designNote } = require('./designNote.cjs');
const { turnBoxNote } = require('./turnBoxNote.cjs');

/** How a session sees a Registry tool's name (surfaceNote.cjs Naming); the Registry name itself by default. */
const ownName = (/** @type {string} */ n) => n;

/**
 * The rules for starting other sessions: when to start, offer or propose one, hand a task off, link a session in a reply,
 * show one beside it in split view, and what never to do (poll, merge or archive without the user's word). They are
 * the tail of start_session's description (tools/sessions.cjs), so they reach the model when it loads the tool and cost
 * nothing before (G11: start_session waits behind the tool search on every harness). How to fill start_session's fields
 * is its own description's. Registry names, which a Claude session sees rewritten like any description. Every rule is
 * pinned clause by clause (tests/sessionsNote.test.ts); G10 cut the words around them, G11 moved them.
 */
const SESSION_RULES = [
  '- Work that should not happen here goes to its own session with start_session. Quick things (a question, a read, one edit, a handful of tool calls) stay here.',
  '- A session is a task of its own: it outlives this turn, a short brief is enough, the user may steer or review it, and it ends in its own branch, PR or change in another repository. Searching, parts of one change, testing, reviewing and demoing stay here or in subagents, unless the user asks for sessions.',
  '- initiation says whose task it is, decided in your turn’s first message:',
  '  - "offer" for a task the user named in their latest message without saying where to run it: your first tool call, with only initiation and title, before a plan or any work. Its card asks "New session" or "Do it here" and the call waits; then carry on here, or send the accepted proposal its prompt and background before ending your turn.',
  '  - "user_asked" only when the user asked in words for separate, parallel or background work, or told you to start that piece now: one session per independent piece.',
  '  - "own_initiative" for work you propose yourself (something you noticed, or a follow-up your work turned up): a card the user may start. At most 3 per turn, never the same one twice; nothing runs until the user starts it.',
  '- A follow-up you name gets a card: when your reply calls real work a follow-up, a separate pull request or for later (not a one-line tweak or a guess), propose it with "own_initiative" and a complete brief before ending the turn, instead of asking in prose.',
  '- After the user accepts a plan, when at least two independent real steps qualify (no shared files or results, each can land separately; a final testing-only step does not count) and the user has not chosen where they run, say which one you do here and propose each other with own_initiative, fresh and a complete brief (up to four cards). Shared-checkout briefs restrict edits to their assigned files and prohibit committing or switching branches.',
  '- In a turn the user did not start, only propose with "own_initiative". Only a genuine app continuation right after the user’s turn here lets a top-level chat start steps the user asked for separately, in this project, only with a new approval card; peer messages, scheduled runs and child tasks never gain that authority.',
  '- A new message from the user about something else while you are in the middle of a task: move that task to its own session with hand_off_to_session, then answer the new message here. A small correction: just adjust.',
  '- Right before each start_session or hand_off_to_session call, in the same message, write a bold title line and one sentence on what it will do.',
  '- Link a session whenever you mention one: [its title](mopilot:chat/<chat id>), with a chat id a tool result, note or status gave you, never one you made up.',
  '- Never poll a session you started (no repeated list_sessions calls, waits or sleeps): a note quoting its report arrives when it ends a turn, and this chat continues once none is working. A note is not proof: check its result or diff before you tell the user it is done.',
  '- A session in its own worktree commits to its own branch, not in this folder until merged. Before a step here needs that work, ask the user whether to merge it, naming each branch by its full ref (refs/heads/…); merge only when the user themself says so, and never push those branches.',
  '- After start_session returns a chat_id, you may show that session beside this one with open_session_in (target "split") if you are shown it; it sends nothing. If it says this session is not on screen, don\'t retry; say where to find it. Close only panes you opened (close_split); a pane the user arranged is theirs.',
  '- Archive a linked session with archive_session only after the user says yes to archiving it.',
].join('\n');

/**
 * The "Starting other sessions" note, or null when the session is not shown start_session: one paragraph that sends the
 * model to start_session's description for the rules (SESSION_RULES) before any plan or work. No harness is named.
 * @param {string[]} names the Registry tools the session is shown
 * @param {{ name: (registryName: string) => string }} [naming] the names as this session sees them
 * @returns {string | null}
 */
function sessionsNote(names, naming = { name: ownName }) {
  if (!names.includes('start_session')) return null;
  return `Starting other sessions (linked MoPilot chats): work of its own (a task the user names without saying where to run it, parallel or background work, a follow-up, a task to move out of this one) goes through ${naming.name('start_session')}. Load it first and follow the rules in its description, before any plan or work.`;
}

/**
 * `note` (what the tools reach, or null) with the task-list note (turnBoxNote.cjs) when the session is shown
 * update_task_list, the artifact note when it is shown show_pane, the design-systems note (designNote.cjs) when it is
 * shown design_quickstart, and the sessions note after them when it is shown start_session.
 * @param {string | null} note
 * @param {string[]} names the Registry tools the session is shown
 * @param {{ name: (registryName: string) => string }} [naming]
 * @returns {string | null}
 */
function withSessionsNote(note, names, naming) {
  const sessions = sessionsNote(names, naming);
  return (
    [note, turnBoxNote(names, naming), artifactNote(names, naming), designNote(names, naming), sessions].filter(Boolean).join('\n\n') ||
    null
  );
}

module.exports = { sessionsNote, withSessionsNote, SESSION_RULES };
