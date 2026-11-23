// Mid-chat harness switching (design §05): a chat becomes a list of segments, each a native session,
// and a handoff record carries the conversation across. Same-harness model changes stay in-session.
// The switch itself, the new segment and the handoff record, is settled in main (electron/session/
// switch.cjs) when the chat's next message goes out; the window only records the choice
// (`pendingSwitch`) and shows the result. The record's wording is in shared/handoff.mjs.
import { codexApi } from '../../harness/adapters/codexApi';
import { chatProxy } from '../../harness/adapters/proxy';
import type { StatusNoteItem, ThreadItem, TurnState } from '../../store/types';
import { chatHarnessLabel } from '../../store/chats';
import { ensureResumed } from '../../store/threads';
import { get as getState, patchRuntime, set as setState, toast } from '../../store/core';
import { replaceChatInView } from '../../store/splitView';
import { startNewChat } from '../../store/send';
import { turnFromServer } from '../../../shared/codexTurns.mjs';
import { readFailed, readSucceeded } from '../../store/chatReads';
import { allFromDisk } from '../../store/codexDisk';
import { loadClaudeTurns } from './claude';
import { readWhileRunning, reopenedTurn } from './claude/history';
import { basicLabel, flushAcpDisplay, readAllAcpTurns } from './acp';
import { isFirstTier } from '../../harness/adapter';
import { harnessInfo } from '../../harness/registry';
import { HARNESS_LABEL, type HarnessId } from '../../harness/types';
import { modelName } from './select';
import { backDivider } from '../../harness/switchPlan';
import { noteIgnored } from '../../lib/ignored';
import { dividerText, sliceSegments } from '../../../shared/handoff.mjs';
import { liveTurnId } from '../../lib/liveTurn';
import { beginHistoryOpen, readStableTranscript } from '../../store/transcriptRead';
import { flushStreamNotifications } from '../../store/notifications';
import { flushHeld } from './claude/items';

/** Where a new chat with a summary goes: a first-tier harness, or a basic one by its id. */
export type NewChatTarget = { family: HarnessId } | { family: 'acp'; basic: string };

/** The harness a new chat with a summary goes to, by name. */
export const targetLabel = (t: NewChatTarget) => ('basic' in t ? basicLabel(t.basic) : HARNESS_LABEL[t.family]);

/**
 * Start an explicitly separate chat carrying a handoff record of this one. Harness switching itself stays in
 * the current chat; this helper is for callers that deliberately want another conversation. Main writes
 * the record now, a first-tier harness as its own note, a basic harness's chat from its transcript; it goes out with
 * the new chat's first message.
 */
export async function newChatWithSummary(chatId: string, target: NewChatTarget): Promise<string | null> {
  toast(`Preparing a summary of this chat from ${chatHarnessLabel(chatId)}…`);
  const r = await chatProxy.handoffNote(chatId, targetLabel(target));
  if ('error' in r) {
    toast(`Couldn't write the handoff note: ${r.error}`, 'error');
    return null;
  }
  // the chat's folder and project as they are now, after the note
  const s = getState();
  const cwd = s.threads[chatId]?.cwd || s.home;
  // the project as the new chat's harness files it: its own id, or the matching Codex project's
  const pid = s.threads[chatId]?.projectId ?? s.chatProject[chatId] ?? null;
  const proj = (pid && s.savedProjects.find((p) => p.id === pid || p.codexId === pid)) || null;
  const id = await startNewChat(target.family, { cwd, proj, ephemeral: undefined, basic: 'basic' in target ? target.basic : null });
  setState((st) => ({
    handoffCarry: {
      ...st.handoffCarry,
      [id]: { text: r.text, fromTitle: st.threads[chatId]?.name || st.threads[chatId]?.preview || 'the earlier chat' },
    },
  }));
  // the new chat takes the old one's pane: a split pane in place, else the primary pane
  replaceChatInView(chatId, id);
  window.dispatchEvent(new Event('focus-composer'));
  return id;
}

/* ------------------------------------------------------------------ */
/* history of a multi-segment chat                                     */
/* ------------------------------------------------------------------ */
/** A Codex part's turns, from the app-server; while Codex is down, from its rollout file (`disk.used` says so). */
async function loadCodexTurns(threadId: string, disk: { used: boolean }): Promise<TurnState[]> {
  // reading needs no lease: a thread another client holds still lists its turns below
  await ensureResumed(threadId).catch((error) => noteIgnored('resume a Codex segment to read its turns', error));
  let all: TurnState[] = [];
  let cursor: string | null = null;
  try {
    for (let i = 0; i < 40; i++) {
      const page = await codexApi.threadTurns(threadId, { limit: 50, cursor, itemsView: 'full' });
      all = [...page.data.map(turnFromServer).reverse(), ...all];
      cursor = page.nextCursor;
      if (!cursor) break;
    }
  } catch (e) {
    const read = await allFromDisk(threadId);
    if (!read) throw e;
    disk.used = true;
    return read;
  }
  return all;
}

const flushHistoryDisplay = () => {
  flushStreamNotifications();
  flushHeld();
  flushAcpDisplay();
};

/** Stitch native histories under one read owner; retry a segment change rather than publishing the retired view. */
export async function openCompositeThread(chatId: string): Promise<void> {
  const opening = beginHistoryOpen(chatId);
  const current = opening.owns;
  try {
    await readStableTranscript(chatId, current, flushHistoryDisplay, async (unchanged) => {
      try {
        const s = getState();
        const segs = s.segments[chatId];
        const cwd = s.threads[chatId]?.cwd ?? '';
        const history = new Map<string, TurnState[]>();
        // the current Claude segment's turn main is running reads open (#1838); Codex reads its turns' status from the app-server
        const last = segs.at(-1);
        const liveNid = last?.harness === 'claude' ? last.nativeId : null;
        let running = false;
        let acpActiveTurn: string | null = null;
        const disk = { used: false };
        // Read the active source last: its stream cannot advance during an await for another source after its snapshot.
        const ids = [...new Set(segs.map((x) => x.nativeId))].filter((id) => id !== last?.nativeId);
        if (last) ids.push(last.nativeId);
        for (const nid of ids) {
          const seg = segs.find((s) => s.nativeId === nid)!;
          if (!isFirstTier(seg.harness)) {
            const read = await readAllAcpTurns(nid, chatId, cwd, { active: nid === last?.nativeId });
            history.set(nid, read.turns);
            if (nid === last?.nativeId) acpActiveTurn = read.activeTurnId;
          } else if (nid === liveNid) {
            const read = await readWhileRunning(chatId, (open) => loadClaudeTurns(nid, chatId, cwd, open));
            running = read.running;
            history.set(nid, read.value);
          } else
            history.set(
              nid,
              segs.find((x) => x.nativeId === nid)?.harness === 'claude'
                ? await loadClaudeTurns(nid, chatId, cwd)
                : await loadCodexTurns(nid, disk),
            );
        }
        if (!current()) return false;
        if (getState().segments[chatId] !== segs) return false;
        const slices = sliceSegments(segs, history);
        const turns: TurnState[] = [];
        segs.forEach((seg, i) => {
          const slice = slices[i].map((t) => ({ ...t, items: [...t.items] }));
          if (i > 0 && slice[0] && seg.handoff) {
            const text =
              seg.handoff.mode === 'delta'
                ? backDivider(harnessInfo(seg.harness)?.label ?? seg.harness, seg.handoff.caught ?? 0, '')
                : // the segment keeps the model's id; the divider names it as the picker does
                  dividerText(
                    segs[i - 1].harness,
                    seg.harness,
                    seg.model ? (isFirstTier(seg.harness) ? modelName(seg.harness, seg.model, s) : seg.model) : '',
                    seg.handoff.mode,
                    seg.handoff.tokens,
                    harnessInfo(segs[i - 1].harness)?.label ?? segs[i - 1].harness,
                    harnessInfo(seg.harness)?.label ?? seg.harness,
                  );
            const note = {
              type: 'statusNote',
              id: `switch-${i}`,
              kind: 'switch',
              text,
              handoff: seg.handoff.text,
            } satisfies StatusNoteItem;
            slice[0].items.unshift(note as unknown as ThreadItem);
          }
          turns.push(...slice);
        });
        // the running turn is the current segment's own last turn; main's items carry it on
        if (running && liveNid && slices.at(-1)?.length) turns[turns.length - 1] = reopenedTurn(turns[turns.length - 1]);
        flushHistoryDisplay();
        if (!unchanged()) return false;
        patchRuntime(chatId, (r) => ({
          ...readSucceeded(r),
          loaded: true,
          loading: false,
          turns,
          olderCursor: null,
          turnsAbove: 0,
          activeTurnId: acpActiveTurn ?? liveTurnId(turns, null),
          // a Codex part read from disk while Codex is down: read again once it is back
          ...(disk.used ? { fromDisk: true } : {}),
        }));
        return true;
      } catch (e) {
        flushHistoryDisplay();
        if (!unchanged()) return false;
        patchRuntime(chatId, () => readFailed(e));
        return true;
      }
    });
  } finally {
    opening.finish();
  }
}
