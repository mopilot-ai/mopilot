// window.native.app's types (the app itself), merged into NativeApi; the calls are declared in electron/bridge/app.cjs.
import type { NotifyKind, NotifyOptions } from '../notify';
import type { QuickActionsStatus } from './contracts/quickActions';

/** What the bug report dialog contributes; main validates and scrubs each field. */
export interface BugInput {
  kind: BugKind;
  description: string;
  /** the chat's harness now ('codex', 'claude', 'acp:<id>'), or null without a chat */
  harness: string | null;
  model: string | null;
  /** the chat as Markdown, read when the dialog opened; empty without a chat */
  transcript: string;
}
export type BugKind = 'bug' | 'bad_result' | 'other';
/** The report as POST /api/bug takes it. */
export interface BugReport {
  installId: string;
  kind: BugKind;
  description: string;
  appVersion: string;
  os: string;
  arch: string;
  channel: string;
  harness: string | null;
  harnessVersion: string | null;
  model: string | null;
  env: Record<string, unknown>;
  diagnostics: string;
  transcript: string;
  errorFingerprints: string[];
}
export type BugErrorKind = 'offline' | 'too_large' | 'rate_limited' | 'server' | 'rejected' | 'unavailable';
export type BugResult =
  | { ok: true; id: string; shortId: string }
  | { ok: false; error: { kind: BugErrorKind; message: string; retryAfterSec?: number | null } };

declare module '../native' {
  interface NativeApi {
    app: {
      /** Main's services, flags and IPC are ready for this window to boot. */
      ready(): Promise<void>;
      info(): Promise<{
        username?: string | null;
        version: string;
        platform: string;
        home: string;
        codexHome: string;
        codexBin: string;
        dark: boolean;
      }>;
      /** The language the interface shows and that language's messages, by their English text (electron/app/language.cjs). */
      language(): Promise<{ tag: string; messages: Record<string, string> }>;
      /** Shown, merged or dropped by the main process (electron/platform/notify.cjs) per Settings → Notifications. */
      notify(kind: NotifyKind, chatId: string, opts: NotifyOptions): Promise<void>;
      /**
       * The chats this window's panes show and the focused one (electron/session/viewing.cjs): main notifies for a chat
       * nobody is looking at, and lets a window answer for the chats it shows.
       */
      viewing(view: { visible: string[]; primary: string | null; focused: string | null }): Promise<void>;
      /** Whether this window holds a draft not yet sent: the app does not restart into an update by itself meanwhile. */
      unsent(has: boolean): Promise<void>;
      setTheme(t: 'system' | 'light' | 'dark'): Promise<void>;
      /** the macOS Quick Actions: true writes the workflows to ~/Library/Services, false removes the ones MoPilot wrote */
      quickActions: { status(): Promise<QuickActionsStatus>; set(on: boolean): Promise<QuickActionsStatus> };
      setTray(on: boolean): Promise<void>;
      icon(id: string): Promise<string | null>;
      installed(): Promise<Record<string, boolean>>;
      /** Opens the shipped THIRD_PARTY_NOTICES.md in the default app (electron/support/notices.cjs). */
      openNotices(): Promise<{ ok: boolean; path?: string; error?: string }>;
      /** Version, harness paths and the redacted environment, as text for a bug report. */
      diagnostics(): Promise<string>;
      /** A bug report to mopilot.ai (electron/support/bugReport.cjs): main scrubs and bounds the window's fields and adds its own. */
      bug: {
        /** The report as it would be sent now. */
        preview(input: BugInput): Promise<BugReport>;
        /** Builds the report again and sends it; a failure comes back typed, never thrown. */
        submit(input: BugInput): Promise<BugResult>;
      };
      /** Records an error the renderer ignored on purpose with main's (use noteIgnored from ./ignored, which falls back without a bridge). */
      ignored(context: string, message: string): void;
      onCommand(cb: (cmd: string, arg?: unknown) => void): () => void;
      onThemeChanged(cb: (dark: boolean) => void): () => void;
    };
  }
}
