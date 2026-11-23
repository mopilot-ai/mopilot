// The read-only terminal mirror of the Mac: its output as ordered byte slices, decoded and cleaned for display.
import { fromBase64 } from '../../../shared/remote/envelope.mjs';

/** The most characters of terminal output kept for display. */
export const MAX_TERMINAL_CHARS = 100_000;
const CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const ESC = /\u001b[@-Z\\-_=>]/g;

export type Terminal = { text: string; at: number; exit: string | null; gap: boolean };
export const emptyTerminal = (at = 0): Terminal => ({ text: '', at, exit: null, gap: false });

/** Terminal text as a screen shows it: escape sequences removed, a carriage return rewinding its line. */
export function display(text: string) {
  return text
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(ESC, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.includes('\r') ? line.slice(line.lastIndexOf('\r') + 1) : line))
    .join('\n');
}

/**
 * Applies one `pty.data` event (stream offset `at`, base64 bytes). Bytes the screen already has are skipped, a start inside them
 * keeps only the new tail, and a start beyond them is a gap: nothing is applied and `gap` asks the caller to reopen from `state.at`.
 */
export function applyData(state: Terminal, decoder: TextDecoder, at: unknown, data: unknown): Terminal {
  if (typeof at !== 'number' || typeof data !== 'string') return state;
  const bytes = fromBase64(data);
  if (at > state.at) return { ...state, gap: true };
  const skip = state.at - at;
  if (skip >= bytes.length) return state;
  const text = decoder.decode(bytes.subarray(skip), { stream: true });
  return { ...state, text: (state.text + text).slice(-MAX_TERMINAL_CHARS), at: at + bytes.length, gap: false };
}

/** How a finished shell is told to the person. */
export function exitText(exitCode: unknown, signal: unknown) {
  if (typeof signal === 'string' && signal) return `The terminal ended (${signal}).`;
  return typeof exitCode === 'number' ? `The terminal ended with code ${exitCode}.` : 'The terminal ended.';
}
