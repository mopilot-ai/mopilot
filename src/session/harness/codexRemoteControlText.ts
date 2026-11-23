// The words for Codex's Remote Control link when it fails or retries, shared by Settings and the summary panel's switch.
import type { CodexRemoteControlView } from '../../harness/adapters/codexApi';

/** Why the link failed, in a line: our words, then the app-server's own last words when it gave any. */
export const codexFailure = (rc: CodexRemoteControlView) => [rc.error, rc.detail].filter(Boolean).join(' · ');

/** The app-server keeps trying on its own: the switch stays on and says so, with the last reason. */
export const codexReconnecting = (rc: CodexRemoteControlView) => `Reconnecting… ${codexFailure(rc)}`.trim();
