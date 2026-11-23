// Claude Code's slash commands a message can't run, left out of the app's / menu (src/harness/commands.ts) and the Chrome side panel's (electron/app/chromePanelCommands.cjs).

/** Commands that open the CLI's own interactive panel, which an SDK session refuses. */
export const CLAUDE_INTERACTIVE_ONLY = ['tasks', 'status', 'memory', 'skills', 'plan', 'permissions', 'feedback', 'resume'];

/** The commands a message can't run: interactive-only, the terminal's own (the CLI names them), exit and clear. */
export const claudeSkipped = (terminalSlash = []) => new Set([...CLAUDE_INTERACTIVE_ONLY, ...terminalSlash, 'exit', 'clear']);
