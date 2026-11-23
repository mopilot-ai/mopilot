// Record a skill: a recording ended (main's computer:recordDone). Its block goes to the composer of the chat that started it (on screen, or its saved draft) as a Computer History attachment, which every harness takes the same way, with a first line asking for a skill; a recording that failed or caught nothing says so.
import { get, toast } from './core';
import { giveBackToComposer } from './send';
import { HOME_KEY, RECORDING_PROMPT, recordingAttachment } from './computerHistory';
import type { WatchRecordResult } from '../lib/native/computer';

export function onWatchRecordDone(r: WatchRecordResult) {
  if (r.error) return void toast(r.error, 'error');
  if (!r.block) return void toast('Nothing was recorded');
  // a second recording before the first was sent adds its block, not a second request
  const asked = get().drafts[r.chatId]?.text?.includes(RECORDING_PROMPT);
  giveBackToComposer(r.chatId === HOME_KEY ? null : r.chatId, asked ? '' : RECORDING_PROMPT, [recordingAttachment(r.steps ?? 0, r.block)]);
  toast(r.limit ? `Recording attached · it reached its ${r.limit} limit` : 'Recording attached');
}
