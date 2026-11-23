// How a chat is named on a Host and in this app. An ACP chat has one id for both (`acp:<harness>:<uuid>`). A Claude Code or Codex chat on a Host is drawn here as an ACP-kind chat, so it reads the transcript this app keeps for it and
// never goes to a Claude or Codex adapter that has no history of it: `acp:host-claude:<uuid>` here is `claude:<uuid>` on the Host, and `acp:host-codex:<uuid>` is the bare `<uuid>` the Host's Codex takes.

const ACP = 'acp:';
/** The families a Host runs besides ACP: the prefix of the app id and of the Host's id. */
const CLAUDE = { app: 'acp:host-claude:', host: 'claude:' };
/** Codex ids are bare on the Host. */
const CODEX = { app: 'acp:host-codex:', host: '' };

/** The harness name a Host chat of each family carries in its app id (`acp:<harness>:<uuid>`), so the registry and the labels read it as that agent. */
const HARNESS_FAMILY = { 'host-claude': 'claude', 'host-codex': 'codex' };

/** The first-tier agent a Host chat's harness name stands for ('host-claude' is Claude Code), or null for any other name. @param {string} harness @returns {'claude' | 'codex' | null} */
export const hostFamilyOfHarness = (harness) =>
  Object.hasOwn(HARNESS_FAMILY, harness) ? HARNESS_FAMILY[/** @type {'host-claude' | 'host-codex'} */ (harness)] : null;

/** The id the Host knows the chat by. @param {string} appId */
export function hostChatId(appId) {
  const row = [CLAUDE, CODEX].find((f) => appId.startsWith(f.app));
  return row ? `${row.host}${appId.slice(row.app.length)}` : appId;
}

/** The id this app uses for a chat the Host names `hostId`: an ACP id is the same, `claude:<id>` is a Claude Code chat, and any other is a Codex thread's bare id. @param {string} hostId */
export function appChatId(hostId) {
  if (hostId.startsWith(ACP)) return hostId;
  return hostId.startsWith(CLAUDE.host) ? `${CLAUDE.app}${hostId.slice(CLAUDE.host.length)}` : `${CODEX.app}${hostId}`;
}

/** The app-id prefix of each harness a Host runs as its own family. */
const FAMILY_PREFIX = { claude: CLAUDE.app, codex: CODEX.app };

/** Whether the harness is one a Host runs as its own family (its sign-in on the machine matters before a chat starts there). @param {string} harness */
export const isHostFamily = (harness) => Object.hasOwn(FAMILY_PREFIX, harness);

/** What every app id of a chat that starts on this harness begins with: `acp:<harness>:` for a basic agent, the Host-family prefix for Claude Code and Codex. @param {string} harness */
export const appIdPrefix = (harness) =>
  isHostFamily(harness) ? FAMILY_PREFIX[/** @type {'claude' | 'codex'} */ (harness)] : `${ACP}${harness}:`;

/** The machine's id for an agent from the Host's harness kind ('claude', 'codex', 'acp:kimi' → 'kimi'); null for none. @param {unknown} kind */
export const agentOfKind = (kind) => (typeof kind === 'string' && kind ? (kind.startsWith(ACP) ? kind.slice(ACP.length) : kind) : null);

/** The harness a chat is started on, by the name a start takes, from the id the Host knows the chat by: `claude:<id>` is Claude Code, `acp:<agent>:<id>` a basic agent, and a bare id a Codex thread. @param {string} hostId @returns {string} */
export const harnessOfHostChat = (hostId) => {
  if (hostId.startsWith(CLAUDE.host)) return 'claude';
  if (hostId.startsWith(ACP)) return `${ACP}${hostId.slice(ACP.length).split(':')[0]}`;
  return 'codex';
};
