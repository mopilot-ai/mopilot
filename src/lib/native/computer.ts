// window.native.computer's types (computer use), merged into NativeApi; the calls are declared in electron/bridge/computer.cjs.
import type { ComputerPermission, ComputerStatus, SageApprovalAnswer } from '../native';

/** How a Record a skill recording ended: its block for the chat (with how many steps), or why there is none. */
/** One of the user's inputs on the pane of a Host chat's desktop; x and y are pixels of the frame shown. */
export type DesktopPaneInput =
  | { kind: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle'; count?: number }
  | { kind: 'scroll'; x: number; y: number; dx: number; dy: number }
  | { kind: 'key'; key: string }
  | { kind: 'text'; text: string };
/** What the pane is sent: a frame, or `idle` (the agent holds no desktop), or an error in words. */
export type DesktopPaneFrame = {
  paneId: string;
  data?: string;
  mime?: string;
  width?: number;
  height?: number;
  pixelsPerPoint?: number;
  /** the Host display's origin in points, and the version of its geometry (the agent's cursor is placed by it) */
  display?: { x: number; y: number };
  version?: number;
  /** the agent's cursor: a plan, the click's press, or its end (src/lib/hostCursor.ts) */
  cursor?: import('../hostCursor').CursorMessage;
  idle?: boolean;
  error?: string;
};

export interface WatchRecordResult {
  /** the chat that started it ('home' for the new chat's box) */
  chatId: string;
  steps?: number;
  durationMs?: number;
  /** the <sage-computer-history> block the chat gets; null when nothing was recorded */
  block?: string | null;
  /** the recording ended at its time or its size limit */
  limit?: 'time' | 'size' | false;
  error?: string;
}

export interface WatchRecordState {
  recording: boolean;
  chatId: string | null;
  startedAt: number | null;
}

declare module '../native' {
  interface NativeApi {
    /** computer use (electron/capabilities/computerUse.cjs) */
    computer: {
      /** answer a card Sage asked for; resolves false when another window answered first */
      answer(id: string, result: SageApprovalAnswer): Promise<boolean>;
      /** after "You took over": let the agent continue; false when the chat no longer controls the Mac */
      resume(chatId: string): Promise<boolean>;
      /** let go of the desktop and stop the chat's turn; false without a chat (never whichever chat holds the desktop) */
      stop(chatId: string): Promise<boolean>;
      /** the control strip's Take over: the agent's input to the app waits until handBack; false when the chat isn't working in it */
      takeOver(chatId: string, bundleId: string): Promise<boolean>;
      handBack(chatId: string, bundleId: string): Promise<boolean>;
      /** the "working in" stack: the app's window at most once a second ('large': the card's opened live view); no thumbnail without Screen Recording already granted */
      workingThumb?(
        chatId: string,
        app: string,
        turnId?: string,
        size?: 'card' | 'large',
      ): Promise<{ thumbnail: string | null; bundleId: string | null }>;
      /** an app's display name, bundle id and icon (a data: URL) for a bundle id or name; null when no installed app matches */
      appIdentity?(app: string): Promise<{ name: string; bundleId: string | null; icon: string | null } | null>;
      /** brings the app to the front (by bundle id when known) */
      bringToFront?(app: string, bundleId: string | null): Promise<boolean>;
      /** the chat was archived or deleted: drop its desktop grants and consent, and let go of the desktop */
      forget?(chatId: string): Promise<boolean>;
      /** the permission guide card's "Check again": true when nothing is missing now */
      recheck(chatId: string): Promise<boolean>;
      /** Settings → Computer use (starts the helper to ask for its permissions) */
      status(): Promise<ComputerStatus>;
      requestPermission(kind: ComputerPermission): Promise<boolean>;
      openSettings(kind: ComputerPermission): Promise<boolean>;
      /** chatId null: the global list */
      revoke(chatId: string | null, bundleId: string): Promise<boolean>;
      /** Settings' "Remove all": empties the always-allowed list; false when it was empty */
      revokeAll(): Promise<boolean>;
      /** a Host's desktop: take one app back (chatId null: from the machine's always-allowed list) */
      revokeOnMachine(machineId: string, chatId: string | null, bundleId: string): Promise<boolean>;
      revokeAllOnMachine(machineId: string): Promise<boolean>;
      /** the pane of a Host chat's desktop (electron/capabilities/hostDesktopView.cjs): frames are polled stills, input counts only after takeover */
      desktopWatch(paneId: string, chatId: string, hostId: string): Promise<boolean>;
      desktopView(paneId: string, view: { visible?: boolean; takeover?: boolean }): Promise<boolean>;
      desktopStop(paneId: string): Promise<boolean>;
      desktopInput(paneId: string, input: DesktopPaneInput): Promise<boolean>;
      onDesktopFrame(cb: (frame: DesktopPaneFrame) => void): () => void;
      setDeny(list: string[]): Promise<string[]>;
      /** Settings: "Allow brief switching to the app when background control doesn't work"; returns the saved value */
      setBriefForeground(on: boolean): Promise<boolean>;
      /** Settings: Codex chats use Codex Computer Use instead of MoPilot's computer use (default off); returns the saved value */
      setCodexNativeComputer(on: boolean): Promise<boolean>;
      onChanged(cb: (e: { chatId: string | null; stoppedByYou?: boolean }) => void): () => void;
      /** Record a skill: starts a recording for a chat ('home': the new chat's box); the pill ends it */
      recordStart(chatId: string): Promise<{ ok: true } | { ok: false; error: string }>;
      recordState(): Promise<WatchRecordState>;
      recordDiscard(): Promise<void>;
      onRecordDone(cb: (result: WatchRecordResult) => void): () => void;
      onRecordChanged(cb: (state: WatchRecordState) => void): () => void;
    };
  }
}
