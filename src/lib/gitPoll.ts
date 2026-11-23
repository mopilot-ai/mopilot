// How often a pane reads its folder's git state (a git status or diff spawns processes, docs/architecture/rust-core.md §2
// idle): often while the chat runs a turn, which is what changes it; seldom while it runs none, when only an edit made
// outside the app does.

/** While the chat runs a turn, and while it runs none. */
export const GIT_POLL_MS = 5000;
export const GIT_IDLE_POLL_MS = 30_000;

/** The shared timer's key (src/lib/visiblePoll.ts) and interval for a pane's git reads. */
export const gitPoll = (name: string, running: boolean): [key: string, ms: number] =>
  running ? [name, GIT_POLL_MS] : [`${name}-idle`, GIT_IDLE_POLL_MS];
