// What MoMo says it is doing, on any harness: one line for its identity (the header's, or the right panel's) from the shown chat's state and whether it is paused.
import type { ChatRowState } from '../../session/chatRowState';

export type MomoLine = { text: string; tone: 'needs' | 'busy' | 'active' | 'paused' };

const BUSY: Partial<Record<ChatRowState, MomoLine>> = {
  approval: { text: 'Needs you', tone: 'needs' },
  input: { text: 'Needs you', tone: 'needs' },
  working: { text: 'Working…', tone: 'busy' },
  elsewhereRunning: { text: 'Working…', tone: 'busy' },
};

/** Paused says so first; else what the chat is doing, and Active while MoMo is on and idle (#2607). */
export const momoLine = (state: ChatRowState, paused: boolean): MomoLine =>
  paused ? { text: 'Paused', tone: 'paused' } : (BUSY[state] ?? { text: 'Active', tone: 'active' });
