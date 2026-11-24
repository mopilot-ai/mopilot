// The app surface of a tiered session's tools (toolTiers.cjs): MoPilot's own tools (the turn's task list and
// wrap-up, sessions, panes, terminals, branches and PRs, settings and the rest) wait behind app_more_tools. A tool named in
// no group here (one added later, a MoMo or connector tool) is in the `other` group, so a new app tool is deferred by
// default. @host-portable: no Electron.

/**
 * The app tools always listed: the e2e fixtures' echo tools and the Host relay's explicit route to this Mac.
 * The task list and wrap-up wait in the `turn` group (browse-only turns need neither).
 */
const APP_CORE = Object.freeze(['sage_debug_echo', 'sage_debug_poke', 'this_mac_control']);

/** The app surface: its more tool and its groups (Registry names); `other` takes every app tool no group names. */
const APP_SURFACE = Object.freeze({
  more: 'app_more_tools',
  about: "More of MoPilot's own tools, in groups",
  skill: null,
  groups: {
    turn: {
      summary: "the turn's task list and its closing wrap-up",
      tools: ['update_task_list', 'wrap_up'],
    },
    sessions: {
      summary: 'start, list, message, hand off, stop and archive linked sessions',
      tools: [
        'start_session',
        'list_sessions',
        'send_message',
        'hand_off_to_session',
        'dismiss_task',
        'stop_session',
        'archive_session',
        'mark_chapter',
      ],
    },
    panes: {
      summary: 'show the diff, a file, the terminal or a preview beside the chat; open a file in the editor',
      tools: ['show_pane', 'close_pane', 'open_in_editor', 'reveal_path', 'open_session_in', 'close_split', 'get_window_layout'],
    },
    terminal: {
      summary: "run and read commands in the user's Terminal panel",
      tools: ['run_in_terminal', 'read_terminal', 'open_terminal_tab', 'stop_terminal_tab'],
    },
    git: {
      summary: 'branches, worktrees and pull request monitoring',
      tools: [
        'propose_branch',
        'set_pr_monitor',
        'get_pr_monitor',
        'sync_with_base_branch',
        'stack_pull_request',
        'get_pr_stack_candidates',
        'clean_up_worktrees',
        'discard_kept_worktree',
      ],
    },
    folders: {
      summary: 'folders outside the working directory, and moving a chat to another folder or project',
      tools: ['request_directory', 'change_directory', 'move_project'],
    },
    other: { summary: 'settings, sidebar, chats, schedules, designs, connectors, simulators, usage and the rest', tools: [], rest: true },
  },
});

module.exports = { APP_CORE, APP_SURFACE };
