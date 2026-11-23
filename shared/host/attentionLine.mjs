// A chat's attention said in words, read by both clients (Remote Run, "A chat's attention"): the word on its row, the line in the strip above the composer and the one action; no component writes these.
import { usdText } from './machineLine.mjs';

/** The minutes after which a run pauses when nobody answers (the Host's own setting: U2); the strip names it. */
export const DEFAULT_PAUSE_MINUTES = 30;

/**
 * What the Host says a chat waits for (U1, U4, U5) and what a client knows about the chat's machine.
 * @typedef {{ kind: 'approval' | 'paused' | 'credential' | 'limit', reason?: string, since?: number }} Attention
 * @typedef {{ attention?: Attention | null, machineName: string, machine?: 'online' | 'offline' | 'reconnecting' | 'asleep', client?: 'mac' | 'phone', pauseMinutes?: number, limitUsd?: number | null }} AttentionInput
 * @typedef {{ row: string | null, strip: string | null, action: { kind: 'resume' | 'signin' | 'raise-limit' | 'wake', label: string } | null }} AttentionLine
 */

/** "30 min", or "2 h" for a pause that is whole hours. @param {number} min */
const span = (min) => (min >= 60 && min % 60 === 0 ? `${min / 60} h` : `${min} min`);

/** The row's word, the strip's line and the one action for a chat. An older Host sends no `attention`: with the machine up, nothing shows. @param {AttentionInput} i @returns {AttentionLine} */
export function attentionLine(i) {
  const { attention, machineName: name } = i;
  switch (attention?.kind) {
    case 'approval':
      return { row: 'Needs you', strip: null, action: null };
    case 'paused':
      return {
        row: 'Paused',
        strip: `Paused: no answer in ${span(i.pauseMinutes ?? DEFAULT_PAUSE_MINUTES)}`,
        action: { kind: 'resume', label: 'Resume' },
      };
    case 'credential':
      return {
        row: 'Needs sign-in',
        strip: `${name} needs this Mac to sign in again`,
        action: i.client === 'phone' ? null : { kind: 'signin', label: 'Sign in' },
      };
    case 'limit':
      return {
        row: 'Limit reached',
        strip: typeof i.limitUsd === 'number' ? `Limit reached: about ${usdText(i.limitUsd)} today` : 'Limit reached',
        action: i.client === 'phone' ? null : { kind: 'raise-limit', label: 'Raise limit' },
      };
    default:
  }
  if (i.machine === 'offline') return { row: 'Offline', strip: `${name} is offline`, action: null };
  if (i.machine === 'reconnecting') return { row: null, strip: `Reconnecting to ${name}…`, action: null };
  if (i.machine === 'asleep') return { row: 'Asleep', strip: `${name} is asleep`, action: { kind: 'wake', label: 'Wake' } };
  return { row: null, strip: null, action: null };
}

/** What Resume sends: one message, as the person; the Host adds its own line telling the agent the earlier action was not run. */
export const RESUME_MESSAGE = 'Continue.';
