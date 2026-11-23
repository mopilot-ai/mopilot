// What a Remote Control switch shows for a chat: the one projection of the link's state (RemoteControlView) the summary
// panel's Session section draws, so a row never reads the state differently from the next.
import type { CodexRemoteControlView } from '../harness/adapters/codexApi';
import type { RemoteControlView } from '../store/session/sessionState';
import { codexFailure, codexReconnecting } from './harness/codexRemoteControlText';

export interface RemoteControlRow {
  /** the switch's position: the link is up or wanted (coming up, or waiting for the network or a sign-in) */
  on: boolean;
  /** the switch cannot be pressed (the harness or login can't link, or there is no session to link yet) */
  disabled: boolean;
  /** the short line under the label, or null */
  note: string | null;
  /** the claude.ai page that follows the session, once the link is up */
  url: string | null;
}

/** States whose link is wanted by the user, whether or not it is up yet. */
const LINKED: ReadonlySet<string> = new Set(['on', 'connecting', 'offline', 'signin']);

/** The note for a link that is wanted but not up (its own error text says why when main has one). */
const WAITING: Record<string, string> = {
  connecting: 'Connecting…',
  offline: 'Reconnecting to claude.ai',
  signin: 'Sign in again to reconnect',
};

/**
 * @param rc the chat's link; null until main first reports one (a session that was never linked reports nothing)
 * @param why why the chat's harness or login can't have a link, or null
 * @param hasRun the chat has run a turn
 */
export function remoteControlRow(rc: RemoteControlView | null, why: string | null, hasRun: boolean): RemoteControlRow {
  if (why) return { on: false, disabled: true, note: why, url: null };
  // a link is made on a session that has run a turn
  if (!hasRun) return { on: false, disabled: true, note: 'Send a message first', url: null };
  if (!rc) return { on: false, disabled: false, note: null, url: null };
  if (rc.state === 'unavailable') return { on: false, disabled: true, note: rc.error ?? 'Not available', url: null };
  if (rc.state === 'error') return { on: false, disabled: false, note: rc.error ?? "Couldn't connect", url: null };
  if (rc.state === 'on') return { on: true, disabled: false, note: 'Linked to claude.ai', url: rc.url };
  if (LINKED.has(rc.state)) return { on: true, disabled: false, note: WAITING[rc.state]!, url: null };
  return { on: false, disabled: false, note: null, url: null };
}

/**
 * Codex's switch: the app-server's link to the user's devices, which is the computer's, so it needs no turn and is the same in every Codex chat.
 * @param rc the link; null before the first read
 * @param why why the chat's login can't have one, or null
 */
export function codexRemoteControlRow(rc: CodexRemoteControlView | null, why: string | null): RemoteControlRow {
  if (why) return { on: false, disabled: true, note: why, url: null };
  if (!rc) return { on: false, disabled: true, note: null, url: null };
  if (rc.retrying) return { on: true, disabled: false, note: codexReconnecting(rc), url: null };
  if (rc.status === 'connecting') return { on: true, disabled: false, note: 'Connecting…', url: null };
  if (rc.status === 'connected') return { on: true, disabled: false, note: 'Connected · this computer', url: null };
  if (rc.status === 'errored') return { on: false, disabled: false, note: codexFailure(rc) || "Couldn't connect", url: null };
  return { on: false, disabled: false, note: rc.error ?? 'Applies to this computer', url: null };
}
