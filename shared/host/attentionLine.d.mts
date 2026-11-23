// Types for attentionLine.mjs: a chat's attention said in words, read by both clients.
export const DEFAULT_PAUSE_MINUTES: number;
export const RESUME_MESSAGE: string;
export type Attention = { kind: 'approval' | 'paused' | 'credential' | 'limit'; reason?: string; since?: number; pauseMinutes?: number };
export type AttentionInput = {
  attention?: Attention | null;
  machineName: string;
  machine?: 'online' | 'offline' | 'reconnecting' | 'asleep';
  client?: 'mac' | 'phone';
  pauseMinutes?: number;
  limitUsd?: number | null;
};
export type AttentionLine = {
  row: string | null;
  strip: string | null;
  action: { kind: 'resume' | 'signin' | 'raise-limit' | 'wake'; label: string } | null;
};
export function attentionLine(i: AttentionInput): AttentionLine;
