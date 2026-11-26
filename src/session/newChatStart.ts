// What new chats start with: the harness, model and effort last used, or Settings' fixed default (prefs.newChatStart).
//
// The working selection (prefs.model/effort/serviceTier for Codex, prefs.claudeSelection for Claude) is what a new chat
// on that harness starts with, and what main reads when it starts one. In 'last' mode every pick already writes it, and
// a sent message writes its chat's harness (prefs.lastHarness, read by store/chats.ts startingHarness) and model and effort.
// In 'default' mode a fresh draft's working selection is set back to prefs.newChatDefault: when the new-chat page opens
// on a draft no one picked a model in, and when the fixed default or the mode changes in Settings. A draft with its own
// pick (session/harness/select.ts composerSelect) gets that pick back when the page opens, in either mode.
import { get, setPrefs } from '../store/core';
import { newChatHarness, savedDefaultHarness } from '../store/chats';
import { onMessageSent } from '../store/send';
import { onMachineNow } from '../lib/hostChats';
import { isMomoChat } from '../lib/momoChats';
import { isHarnessKind } from '../../shared/defaultHarness.mjs';
import { isFirstTier, type HarnessKind } from '../harness/adapter';
import type { HarnessId } from '../harness/types';
import type { AppState } from '../store/state';
import type { Prefs } from '../store/types';
import { clearDraftPick, draftPicked, rememberChatSelection, selectionFor, setSelection } from './harness/select';

export type NewChatStart = Prefs['newChatStart'];

/** 'last' unless the user chose a fixed default (older prefs have neither: they follow the last used). */
export const newChatStartMode = (s: AppState = get()): NewChatStart => (s.prefs.newChatStart === 'default' ? 'default' : 'last');

/**
 * A message main took in a chat here: its harness becomes the last used, and, while new chats follow it, a Codex or
 * Claude chat's own model and effort that harness's (with a fixed default they would only change an open draft under
 * the user). A chat on another machine (its machine remembers its own picks) and MoMo's chats don't count.
 */
export function rememberUsedChat(chatId: string, kind: HarnessKind) {
  const s = get();
  if (!isHarnessKind(kind) || onMachineNow(chatId) || isMomoChat(s.momoChats, chatId)) return;
  if (s.prefs.lastHarness !== kind) setPrefs({ lastHarness: kind });
  if (newChatStartMode(s) === 'last') rememberChatSelection(chatId);
}
onMessageSent(rememberUsedChat);

/** The fixed default that applies now, or null: 'default' mode, saved for the default harness, on Codex or Claude Code. */
function fixedDefault(s: AppState) {
  const d = s.prefs.newChatDefault;
  if (newChatStartMode(s) !== 'default' || !d || d.harness !== savedDefaultHarness(s)) return null;
  return isFirstTier(d.harness) ? { harness: d.harness, model: d.model, effort: d.effort } : null;
}

/** Set `h`'s working selection to this model and effort, when it differs. */
function restore(h: HarnessId, want: { model: string | null; effort: string | null }, s: AppState) {
  const cur = selectionFor(h, s);
  if (cur.model !== want.model || cur.effort !== want.effort) setSelection(h, { model: want.model, effort: want.effort }, null);
}

/**
 * Start the draft from what it should show. A draft the user picked a model or effort in gets that pick back, in either
 * mode: a pick in another chat or window since wrote the same working selection. Otherwise, with a fixed default, its
 * model and effort. `force` (a change in Settings, which the user just made) drops the draft's pick for the default.
 */
export function applyNewChatDefault(force = false) {
  const s = get();
  const pick = force ? null : draftPicked(s);
  // a draft since moved to a newer last used harness leaves the old one's selection as it is now
  if (pick) return pick.h === newChatHarness(s) ? restore(pick.h, pick.sel, s) : undefined;
  clearDraftPick();
  const d = fixedDefault(s);
  if (d) restore(d.harness, d, s);
}

/**
 * Settings → New chats start with. Choosing a fixed default with none saved yet keeps what the default harness uses now,
 * so the next new chat doesn't change under the user.
 */
export function setNewChatStart(mode: NewChatStart) {
  const s = get();
  const h = savedDefaultHarness(s);
  const keep = mode === 'default' && s.prefs.newChatDefault?.harness !== h && isFirstTier(h) ? selectionFor(h, s) : null;
  const fixed = keep && { newChatDefault: { harness: h, model: keep.model, effort: keep.effort } };
  setPrefs({ newChatStart: mode, ...fixed });
  applyNewChatDefault(true);
}

/**
 * Settings' fixed model and effort for new chats on `harness` (the default harness, set alongside: choosing it also makes
 * it the latest choice while new chats follow the last used, store/draftHarness.ts defaultChoicePrefs).
 */
export function setNewChatDefault(harness: HarnessKind, model: string | null, effort: string | null) {
  setPrefs({ newChatDefault: { harness, model, effort } });
  applyNewChatDefault(true);
}
