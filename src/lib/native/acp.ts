// window.native.acp's types (ACP (basic) harnesses), merged into NativeApi; the calls are declared in electron/bridge/acp.cjs.
import type { AcpEvent, BasicHarnessStatus } from '../native';

/** The user's own MCP servers on a basic harness, as Settings and a chat's note show them. */
export interface OwnMcpStatus {
  harness: string;
  label: string;
  supported: boolean;
  /** whether the harness's own servers load in MoPilot's chats */
  load: boolean;
  /** managed: MoPilot's MCP gateway runs it instead (#2999 C4), so MoPilot's chats load no copy of their own */
  servers: { name: string; enabled: boolean; off: boolean; managed?: boolean }[];
  /** a change waits for the harness's running turns to end */
  pending: boolean;
}

declare module '../native' {
  interface NativeApi {
    /** basic-tier harnesses over ACP (electron/harness/acp.cjs) */
    acp: {
      /** every basic harness and its runtime admission (electron/harness/admission.cjs) */
      harnesses(): Promise<BasicHarnessStatus[]>;
      registryList(force?: boolean): Promise<{
        agents: (import('../../../shared/acpRegistry.mjs').RegistryAgent & {
          installed: boolean;
          installedVersion: string | null;
          needsUpdate: boolean;
          repairAvailable: boolean;
          available: boolean;
        })[];
        error: string | null;
      }>;
      registryInstall(id: string): Promise<{ id: string; file: string }>;
      registryRepair(id: string): Promise<{ id: string; file: string }>;
      /** probe again: one harness, or every installed one */
      recheck(id?: string): Promise<BasicHarnessStatus[]>;
      /**
       * sign in with an ACP auth method that has no terminal command, joining the harness's sign-in under way; the list
       * as checked again after it, or as it was when the sign-in was cancelled
       */
      authenticate(id: string, methodId: string): Promise<{ harnesses: BasicHarnessStatus[]; cancelled: boolean }>;
      /** the sign-ins under way: harness id -> the auth method it waits on */
      signIns(): Promise<Record<string, string>>;
      /** stop waiting for the harness's sign-in; false when none was under way */
      cancelSignIn(id: string): Promise<boolean>;
      onSignIns(cb: (list: Record<string, string>) => void): () => void;
      onHarnesses(cb: (list: BasicHarnessStatus[]) => void): () => void;
      /** the user's answer to a permission card: an optionId, or null to cancel */
      permission(requestId: string, optionId: string | null): Promise<boolean>;
      /** a page of the transcript's turns as JSON, for this side to parse, translated in main (electron/harness/items/acp.cjs), with the turn this session is running */
      turns(
        key: string,
        chatId: string,
        cwd: string,
        opts?: { limit?: number; before?: string | null },
      ): Promise<{ page: Uint8Array; activeTurnId: string | null; diffs: Record<string, string> }>;
      list(): Promise<
        {
          id: string;
          harness: string;
          cwd: string;
          preview: string;
          name: string | null;
          /** the agent's own id for the chat's latest session, which its CLI resumes by */
          sessionId?: string | null;
          createdAt: number;
          updatedAt: number;
        }[]
      >;
      /** chats whose title or Sage transcript holds the term, newest first; `scope` names the search box asking: its next search replaces its scan still running */
      search(
        term: string,
        limit?: number,
        scope?: string,
      ): Promise<
        { id: string; harness: string; cwd: string; preview: string; name: string | null; createdAt: number; updatedAt: number }[]
      >;
      /** Names the chat here; for a chat on a machine, `{ error }` says why the machine did not take the name (it stays here) */
      rename(key: string, name: string): Promise<{ error: string; hostId?: string } | null>;
      setMode(key: string, modeId: string): Promise<void>;
      setConfigOption(key: string, configId: string, value: unknown): Promise<void>;
      /** the mode and config values a chat's transcript recorded, which its session is reopened on */
      recordedSettings(key: string): Promise<{ mode?: string; config: Record<string, unknown> }>;
      /**
       * the user's own MCP servers for a basic harness (electron/harness/acp/ownMcp.cjs): those its settings list, each
       * with whether MoPilot turns it off; supported is false for a harness that can't turn them off
       */
      ownMcp(id: string): Promise<OwnMcpStatus>;
      onEvent(cb: (e: AcpEvent) => void): () => void;
      /** a chat's items, as main translates its events (electron/harness/items/acp.cjs): Codex-shaped notifications */
      onItems(cb: (e: { chatId: string; key: string; method: string; params: Record<string, unknown> }) => void): () => void;
    };
  }
}
