// A chat's list state as Claude for iOS's session glyph draws it: waiting (hand), working (ring), new (blue dot), stopped, idle.
import type { SessionState } from '../components/SessionRow';
import type { ChatStateChip } from './chatChips';

/** Needs you waits; running works; a failed or lost turn reads as stopped; a finished turn nobody has opened is new (a blue dot); a quiet or offline chat is an idle ring. */
export function sessionState(chip: ChatStateChip): SessionState {
  if (chip === 'needsYou') return 'waiting';
  if (chip === 'running') return 'working';
  if (chip === 'failed') return 'stopped';
  if (chip === 'done') return 'new';
  return 'idle';
}

/** The initials on the drawer's Settings circle: the first letters of the first two words of the name, else of the email. */
export function initialsOf(user: { name?: string | null; email?: string | null } | null | undefined): string {
  const words = (user?.name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length)
    return words
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join('');
  const email = (user?.email ?? '').trim();
  return email ? email[0].toUpperCase() : '·';
}
