// The tools a chat uses to start or propose linked chats and work with them (start_session, dismiss_task,
// hand_off_to_session, list_sessions, send_message, stop_session, archive_session) and to keep its task list and wrap-up box
// (update_task_list, wrap_up), the same on Codex, Claude Code and admitted ACP harnesses. The calling chat is always
// the one that owns the call's segment, never one an argument names.
const { ToolError } = require('../contract/registry.cjs');
const { registerRemoteControlTool } = require('./remoteControl.cjs');
const { registerMainRepairTools } = require('./mainRepair.cjs');
const { SESSION_RULES } = require('../contract/sessionsNote.cjs');

/**
 * @param {any} registry
 * @param {{ orchestrator: InstanceType<typeof import('../../session/orchestration/service.cjs')['Orchestrator']>, owner: (ctx: any) => string | null }} o
 * @returns {() => void} removes the tools
 */
function registerSessionTools(registry, { orchestrator, owner }) {
  const add = (name, description, properties, required, policy, handler) =>
    registry.register({
      name,
      description,
      schema: { type: 'object', properties, required, additionalProperties: false },
      policy,
      authorizesItself: policy === 'act',
      handler: async (args, ctx) => {
        const chatId = owner(ctx);
        if (!chatId) throw new ToolError('The caller does not own this chat segment', 'no_owner');
        if (orchestrator.unavailable)
          throw new ToolError(`Linked sessions are unavailable: ${orchestrator.unavailable}`, orchestrator.unavailable);
        try {
          return await handler(args, chatId, ctx);
        } catch (error) {
          if (typeof error?.code === 'string') throw new ToolError(error.message, error.code);
          throw error;
        }
      },
    });
  const string = (description) => ({ type: 'string', description });
  // the files a session sharing this folder writes (session/orchestration/writeScope.cjs)
  const PATHS = {
    type: 'array',
    items: { type: 'string' },
    description:
      'With use_worktree false: globs of the files it will write, relative to this folder (e.g. "src/api/**", "docs/api.md"; at most 20). Required while another session you started is working in this folder, and must not overlap its paths',
  };
  const disposers = [
    registerMainRepairTools(registry, { owner, service: () => orchestrator.o.mainRepair() }),
    add(
      'start_session',
      'Start a separate MoPilot chat for a task of its own while you stay with the user. initiation: "user_asked" starts now only when the user asked for separate, parallel or background sessions; "offer" takes a title alone as the first call of a new-task turn, asks "New session" or "Do it here", and WAITS for the answer (the only call in that message; a minute without one answers "Do it here"). Its result tells you to work here or deliver prompt+background with proposal_id for the reserved session. "own_initiative" proposes independent work you noticed, at most 3 per turn; nothing runs until the user starts the card or tells you to start that proposal. prompt is required except on title-only offers. context "fresh" (default) needs background of at least 80 characters: the goal, decisions, constraints and how this task fits. "fork" inherits this conversation, or truthfully reports an excerpt fallback where native fork is unavailable. A fresh worktree starts from the base branch; a fork uses the committed parent tip, leaving uncommitted edits here. use_worktree false shares this folder and requires nonoverlapping paths while another linked chat works there. Starts on this chat’s harness unless the user named another; harness "auto" picks a capable harness with usage left, this one first. A fresh model/effort may be requested at or below the parent’s cost; permissions cannot increase. There is no global parallel slot queue: after 10 starts since the last user message, another start asks for approval. A genuine top-level app continuation may start user-requested steps in this project only after new approval, at most 10 total and 5 still working; peer, scheduled and child-task turns cannot start sessions. after names sessions this chat started: the child waits and starts with their reports/branches when they finish cleanly; a failed predecessor holds it. Each child turn sends a note quoting 400 characters; when none is working the app continues this chat. Follow up with the existing session; never poll or invent its results.\n\nRules for starting sessions:\n' +
        SESSION_RULES,
      {
        title: string('Under 60 characters; names the task in the sidebar, cards and notes'),
        prompt: string('The brief: the task, the files or area, and what done looks like'),
        background: string(
          'Required with "fresh": at least 80 characters of the overall goal, decisions, constraints and how this piece fits; the new session knows nothing else',
        ),
        model: string(
          'Fresh only: an optional model in the same family at or below this chat’s model cost; a higher or unknown tier is ignored',
        ),
        effort: string('Fresh only: optional effort at or below this chat’s current effort'),
        permission_mode: string('Optional permissions at or below this chat’s own permission mode; an increase is refused'),
        name: string('Optional short handle ([a-z0-9-], at most 24); derived from the title when omitted'),
        initiation: {
          type: 'string',
          enum: ['user_asked', 'offer', 'own_initiative'],
          description: 'Whose task it is (default user_asked)',
        },
        context: {
          type: 'string',
          enum: ['fork', 'fresh'],
          description: 'fork: this conversation plus the prompt; fresh (default): the prompt and background only',
        },
        use_worktree: {
          type: 'boolean',
          description:
            'Omitted: share a plain folder that has never used a worktree; otherwise create an independent worktree. true: its own worktree. false: share this folder',
        },
        paths: PATHS,
        harness: string(
          'Omit: it runs on this chat’s current harness. "auto": MoPilot picks by what it needs and the usage left, this chat’s harness first. Another one (codex, claude or acp:<id>) only when the user named it; one they didn’t is set aside',
        ),
        needs: {
          type: 'array',
          items: { type: 'string', enum: ['computer_use'] },
          description:
            'What the session needs of its harness: with harness "auto" only one that can is picked; a named one that can’t is refused',
        },
        after: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Ids or names of sessions this chat started that must finish a turn cleanly before this one starts (at most 10); it waits meanwhile',
        },
        proposal_id: string(
          'Start this proposal exactly as proposed. Only an accepted title-first offer also takes prompt and background to deliver its brief',
        ),
      },
      [],
      'act',
      (a, chatId, ctx) => orchestrator.start(chatId, a, ctx),
    ),
    add(
      'dismiss_task',
      'Withdraw a session you proposed (its task_id) that the user has not started: it went stale, the work was done here after all, or a better-scoped proposal replaces it (propose the new one first).',
      { task_id: string('The proposal’s task_id'), reason: string('Optional one-line reason') },
      ['task_id'],
      'act',
      (a, chatId) => orchestrator.dismiss(chatId, a),
    ),
    add(
      'hand_off_to_session',
      'Move the task you are in the middle of into its own linked session (a fork of this conversation with the plan that is left), so you can answer the user’s new, unrelated message here. Use it only in a turn the user started. After it, stop that task here and answer the new message.',
      {
        title: string('Under 60 characters; names the task being moved'),
        remaining_plan: string('What is left: steps, files, what done looks like'),
        use_worktree: { type: 'boolean', description: 'Default false: it goes on in this folder. true: a new git worktree of it' },
        paths: PATHS,
      },
      ['title', 'remaining_plan'],
      'act',
      (a, chatId) => orchestrator.handOff(chatId, a),
    ),
    add(
      'list_sessions',
      'List the sessions linked to this chat (the chat that started it, the ones it started, and theirs) with each one’s id, name, state (working, needs the user, queued, waiting or held for the sessions it starts after, failed, idle), folder, branch and latest report. Use it, never a search, to find a session you started.',
      { linked: { type: 'boolean', description: 'Linked sessions (the only listing here)' } },
      [],
      'observe',
      (_a, chatId) => orchestrator.list(chatId),
    ),
    add(
      'send_message',
      'Send a message to a linked session: a follow-up to one you started, or to your parent ("parent") when you are blocked. It runs as that session’s next turn (queued while it is working, where the user can remove it before it runs: list_sessions then lists it under removed_messages). A session you started reports back with a note when that turn ends; never poll for it.',
      { to: string('The session’s id, its name, or "parent"'), message: string('The message (at most 32 KB)') },
      ['to', 'message'],
      'act',
      (a, chatId) => orchestrator.message(chatId, a),
    ),
    add(
      'stop_session',
      'Stop the running turn of a session this chat started. Its note says it was stopped.',
      { id: string('The session’s id or name') },
      ['id'],
      'act',
      (a, chatId) => orchestrator.stop(chatId, a),
    ),
    add(
      'archive_session',
      'Archive a session this chat started (directly or further down), only after the user said yes to archiving it. It moves to the archive, where the user can restore it; what waited to be sent to it is dropped. A session that is working or waiting for the user is refused: stop it with stop_session first.',
      { id: string('The session’s id or name') },
      ['id'],
      'act',
      (a, chatId) => orchestrator.archive(chatId, a),
    ),
    add(
      'update_task_list',
      'Keep this chat’s task list, pinned under the latest message where the user follows your progress. Every request that edits files or runs more than one command gets one; only a single-step answer or pure conversation does not. Send it IN THE SAME MESSAGE as another tool call, never alone.\n- First call: with the very first tool call of the turn, even one that only reads: {"items": [...]}, the whole plan in order, short steps, the one you are starting in_progress, the rest pending.\n- Next step: {"advance": true} alongside the call that begins it; out of order, {"done": [2], "start": 4} (1-based).\n- After the user’s new message, even a correction or a question mid-task: {"items": [...]} again, the list for that message, before your other work; until you send it the app shows the old list as the plan from before their message, and wrap_up refuses it. After a wake-up, reconcile the list with what actually completed.\n- Keep one step in progress while working, and mark every step you performed completed before wrap_up. Never mark unfinished or blocked work completed: work still waiting (CI, a merge, the user) stays a pending step. If waiting for CI or a PR merge, register set_pr_monitor.continuation with the condition and already-authorized next steps before ending the turn; a task list alone does not schedule work.\nKeep your plan here instead of in a plan or todo tool of your own, and do not restate it in your message, so the user sees one list.',
      {
        items: {
          type: 'array',
          description: 'The whole list, in order (1 to 20 steps of a few words each)',
          items: {
            type: 'object',
            properties: { content: string('The step'), status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } },
            required: ['content', 'status'],
            additionalProperties: false,
          },
        },
        advance: { type: 'boolean', description: 'Complete the step in progress and start the next pending one after it' },
        done: { type: 'array', items: { type: 'integer' }, description: 'Steps to mark completed, numbered from 1' },
        start: { type: 'integer', description: 'The step to put in progress, numbered from 1' },
      },
      [],
      'observe',
      (a, chatId) => orchestrator.taskList(chatId, a),
    ),
    add(
      'wrap_up',
      'Close a turn that changed files, ran commands or finished multi-step work: a recap of what is now true and where it stands (what is not done or not checked), in the user’s language, and, only when the next move is the user’s, one short question with one or two answers they can click (your recommendation first). Call it once, when the work is done, before any closing message. It checks off the task list’s last step when that step is the one in progress, so no closing update_task_list is needed; any other open step stays open, so first mark finished steps done and keep blocked or unperformed work pending. With a question and answers the app draws a box under the turn that ends it: write no text after the call. A recap alone draws no box (it is the session’s status, and a linked session’s recap is the report its parent gets): write your closing message after the call, as your answer. Follow what the call returns.',
      {
        recap: string('Two or three short sentences to the user (at most 600 characters)'),
        ask: string('Optional: the one decision left to the user (at most 200 characters)'),
        actions: {
          type: 'array',
          description: 'Optional, with ask: 1 or 2 answers, your recommendation first',
          items: {
            type: 'object',
            properties: {
              label: string('The button, 1 to 3 words (at most 24 characters)'),
              message: string('What clicking sends as the user’s reply; the label when omitted'),
            },
            required: ['label'],
            additionalProperties: false,
          },
        },
      },
      ['recap'],
      'observe',
      (a, chatId) => orchestrator.wrapUp(chatId, a),
    ),
  ];
  return () => disposers.forEach((dispose) => dispose());
}

// the Remote Control tool is a session tool too: main registers it beside these
module.exports = { registerSessionTools, registerRemoteControlTool };
