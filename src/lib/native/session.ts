// window.native.session's types (each chat's live state and send queue), merged into NativeApi; the calls are declared in electron/bridge/session.cjs.
import type { SendReceipt } from '../../../shared/sendReceipt.mjs';
import type { CapsHint, ChatCaps, HarnessCaps } from '../../../shared/model/session';
import type { QueuedOptions, SessionPatch, SessionState } from '../../../shared/model/session';
import type { Attachment } from '../../../shared/model/store';

declare module '../native' {
  interface NativeApi {
    /** each chat's live state and send queue, owned by main (electron/session) */
    session: {
      answerQuestion(
        chatId: string,
        id: string,
        answer: import('../../../shared/acpForm.mjs').AcpAnswer,
      ): Promise<import('../../../shared/acpForm.mjs').AcpDelivery>;
      snapshot(chatId: string): Promise<SessionState | null>;
      /** the chats with an approval or question waiting */
      withApprovals(): Promise<string[]>;
      /** keys windows own: plan, permission, goal, pendingSwitch; true when it changed something */
      patch(chatId: string, partial: Partial<SessionState>): Promise<boolean>;
      /** Change only the current pending destination's model, preserving concurrent edits from other windows. */
      pendingModel(chatId: string, harness: string, model: string | null, effort?: string | null): Promise<boolean>;
      /** the ChatController starts, queues or steers it */
      send(
        chatId: string,
        item: { id?: string; text: string; attachments: Attachment[]; opts: QueuedOptions; followUp?: string; retryAtRevision?: number },
      ): Promise<SendReceipt>;
      removeQueued(chatId: string, qid: string): Promise<boolean>;
      sendNow(
        chatId: string,
        qid: string,
      ): Promise<{
        status: 'sent' | 'queued' | 'held' | 'missing' | 'failed';
        error?: string;
        waitingFor?: 'compaction' | 'compactionRetry' | 'host';
      }>;
      /** a Claude session this window just created (a new chat, a side chat, a later segment): its first message starts it instead of resuming it */
      claudeNew(key: string, info: { cwd?: string | null; ephemeral?: boolean; forkFrom?: string | null }): Promise<boolean>;
      /** what the chat picked for itself, so main starts its turns with it (null clears) */
      claudeOwn(chatId: string, own: import('../../../shared/model/native').ClaudeOwn | null): Promise<boolean>;
      /** the chat is moving to another login with its goal carried over: the turn that just ended isn't the goal's end */
      claudeHandover(chatId: string, on: boolean): Promise<void>;
      /** a goal button on a Claude chat; main pauses, resumes or clears it (electron/harness/claude/adapter.cjs) */
      claudeGoal(chatId: string, action: 'pause' | 'resume' | 'extend' | 'clear', human?: boolean): Promise<void>;
      /** Stop on a Claude chat: its goal is paused when active, then the turn is interrupted; `turnId`: only that turn */
      claudeStop(chatId: string, turnId?: string): Promise<true | 'retired' | void>;
      /** The chat was cleared (/clear): main ends the per-chat processes it can resume later (a Claude chat's idle CLI). */
      release(chatId: string): Promise<{ claude: number }>;
      /** an ACP chat this window just created: its folder is where its session starts */
      acpNew(key: string, info: { cwd?: string | null }): Promise<boolean>;
      /** Stop on an ACP chat: session/cancel; `turnId`: only that turn (else 'retired') */
      acpCancel(key: string, turnId?: string): Promise<boolean | 'retired'>;
      /** what the chat can do now, resolved in main; `hint`: what this window knows and main doesn't yet */
      caps(chatId: string | null, hint?: CapsHint): Promise<ChatCaps | null>;
      onCapsChanged(cb: () => void): () => void;
      /** what a new chat on `kind` gets once its session opens (electron/session/harnessCaps.cjs); null for a kind main doesn't know */
      harnessCaps(kind: string): Promise<HarnessCaps | null>;
      onPatch(cb: (p: SessionPatch) => void): () => void;
      /** what a Claude Code or ACP turn changed in its folder so far, or in all (electron/session/turnSnapshots.cjs) */
      onTurnDiff(cb: (d: { chatId: string; turnId: string; diff: string | null }) => void): () => void;
      /** what this window's new-chat composer would start on its first send (null: nothing); main warms it (#1664) */
      prewarm(spec: { kind: string; cwd?: string; params?: Record<string, unknown> | null } | null): void;
      /** that send takes it: a Claude chat's session id, a Codex thread/start answer, or null (start cold) */
      prewarmTake(spec: { kind: string; cwd?: string; params?: Record<string, unknown> | null }): Promise<unknown>;
      /** this window is open: events about a message it sent come back to it */
      ready(): void;
      /** a new chat on a basic harness: the summary the harness the chat is on writes */
      handoffNote(chatId: string, targetLabel: string): Promise<{ text: string } | { error: string }>;
      /** the switch sheet's lines: the surfaces whose controller a switch to `harness` would change (electron/session/controllerPlan.cjs) */
      controllerChanges(chatId: string, harness: string): Promise<string[]>;
    };
  }
}
