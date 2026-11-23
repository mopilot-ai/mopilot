// window.native.pullRequests' types (the sidebar PR badges' saved replies), merged into NativeApi; the calls are declared in electron/bridge/pullRequests.cjs.
import type { ResponseTurn } from '../responsePullRequest';

declare module '../native' {
  interface NativeApi {
    pullRequests: {
      /** The chat's PR replies saved at `version` (a launch before read its history at that version), or null. */
      savedReplies(id: string, version: string): Promise<ResponseTurn[] | null>;
      /** Save the chat's PR replies read at `version`; whether main kept them (it skips one too long to keep). */
      saveReplies(id: string, version: string, replies: readonly ResponseTurn[]): Promise<boolean>;
    };
  }
}
