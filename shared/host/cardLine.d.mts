// Types for cardLine.mjs: a card's states said in words, read by both clients.
export const REMIND_MS: number;
export const PAUSE_MS: number;
export type OptionKind = 'allow' | 'deny' | 'other';
export type Device = { name: string; at?: number };
export type CardState =
  | { state: 'waiting'; since: number; remindMs?: number; pauseMs?: number }
  | { state: 'sent' }
  | { state: 'answered'; optionKind: OptionKind; by?: Device | null }
  | { state: 'lost'; by: Device }
  | { state: 'expired' | 'stopped' | 'turn_ended' | 'restarted' | 'moved' | 'unreachable' | 'policy' };
export type CardLine = {
  text: string | null;
  hover?: number;
  action: { kind: 'retry' | 'try-again'; label: string } | null;
  progress?: boolean;
};
export function pausesIn(since: number, now: number, remindMs?: number, pauseMs?: number): string | null;
export function cardLine(s: CardState, c: { now: number; machineName?: string; org?: string }): CardLine;
export function sentFrom(deviceName: string | null | undefined): string | null;
