// Which of Claude Code's assistant messages are its own and not the model's, for main's readers of a reply. The failures themselves are the core's (core/crates/translate/src/claude/failures.rs).

export const isSyntheticAssistant = (m) => !!m.error || m.message?.model === '<synthetic>';
