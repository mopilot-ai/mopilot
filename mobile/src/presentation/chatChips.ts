// The chips a chat row shows: what the chat is doing for the user, which agent runs it, and (where the Mac has several) which login.
export type ChatStateChip = 'running' | 'quiet' | 'needsYou' | 'failed' | 'done' | 'idle' | 'offline';
export type ChatChips = { state: ChatStateChip; stateLabel: string; harness: string | null };
type ChatLike = { state?: string; unread?: boolean; harness?: string; at?: number; ended?: string };
const LABELS: Record<ChatStateChip, string> = {
  running: 'Running',
  quiet: 'No recent update',
  needsYou: 'Needs you',
  failed: 'Failed',
  done: 'Done',
  idle: 'Idle',
  offline: 'Offline',
};
/** How long a running chat may say nothing before the phone stops saying it is Running: it cannot know the agent is still going, only that it was. */
export const QUIET_AFTER_MS = 5 * 60 * 1000;
const NAMES: Record<string, string> = { codex: 'Codex', claude: 'Claude Code' };

/** A harness id as a chip reads: the two built-in agents by name, an added one by its own id ("acp:gemini-cli" is "Gemini cli"). */
export function harnessChip(id: unknown): string | null {
  if (typeof id !== 'string' || !id) return null;
  if (NAMES[id]) return NAMES[id];
  const own = id.replace(/^acp:/, '').replace(/[-_]+/g, ' ').trim();
  return own ? own[0].toUpperCase() + own.slice(1) : null;
}

/** The login a chat runs on as a chip, when the Mac names one (it does only where the agent has several accounts); trimmed and kept short. */
export function accountChip(v: unknown): string | null {
  const name = typeof v === 'string' ? v.trim() : '';
  if (name.length <= 40) return name || null;
  // what tells two logins apart is the end of an address: a long name loses its middle, not its domain
  const at = name.lastIndexOf('@');
  const domain = at > 0 ? name.slice(at) : '';
  return domain && domain.length <= 24 ? `${name.slice(0, 39 - domain.length)}…${domain}` : `${name.slice(0, 39)}…`;
}

/** The Mac says running, waiting (for the user) or idle; a linked session whose last turn failed or was lost is Failed, as the Mac's sidebar says; an idle chat that finished a turn the user has not opened is Done. A running chat the Mac last heard from (`at`) a while ago is "No recent update" at `now`. When the list is the last one read (the computer is away) no state is claimed: every chat is Offline. */
export function chatChips(chat: ChatLike, now = Date.now(), offline = false): ChatChips {
  const quiet = typeof chat.at === 'number' && now - chat.at > QUIET_AFTER_MS;
  const state: ChatStateChip = offline
    ? 'offline'
    : chat.state === 'running'
      ? quiet
        ? 'quiet'
        : 'running'
      : chat.state === 'waiting'
        ? 'needsYou'
        : chat.ended === 'failed' || chat.ended === 'lost'
          ? 'failed'
          : chat.unread === true
            ? 'done'
            : 'idle';
  return { state, stateLabel: LABELS[state], harness: harnessChip(chat.harness) };
}

const URGENCY: ChatStateChip[] = ['needsYou', 'failed', 'running', 'done'];

/**
 * The one state a folded list of linked sessions shows beside its count, as the Mac's sidebar marks a folded family:
 * the most urgent of needs you, failed, running and finished unread, else none. None while the list is the last one read.
 */
export function nestedState(chats: ChatLike[], now = Date.now(), offline = false): ChatStateChip | null {
  const states = new Set(chats.map((chat) => chatChips(chat, now, offline).state));
  return URGENCY.find((state) => states.has(state)) ?? null;
}

/** A state in words ("Needs you", "Failed"), for a screen reader. */
export const chatStateLabel = (state: ChatStateChip): string => LABELS[state];
