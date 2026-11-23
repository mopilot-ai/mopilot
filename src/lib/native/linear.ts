// window.native.linear's types (Linear issues to start chats from), merged into NativeApi; the calls are declared in electron/bridge/linear.cjs.
export {};

/** A Linear issue (electron/platform/linearSource.cjs): `branch` is Linear's suggested branch name; `context` its text quoted for the agent, read when the chat starts. */
export type LinearSource =
  | {
      ok: true;
      kind: 'linear';
      key: string;
      title: string;
      url: string;
      state: string;
      done: boolean;
      branch: string | null;
      context?: string;
    }
  | { ok: false; error: string };

declare module '../native' {
  interface NativeApi {
    linear: {
      /** Whether a key is saved, and its last four characters. */
      status(): Promise<{ connected: boolean; last4: string | null }>;
      /** Check the user's personal API key with Linear, then keep it encrypted. */
      connect(apiKey: string): Promise<{ ok: true; name: string } | { ok: false; error: string }>;
      disconnect(): Promise<{ ok: true }>;
      /** Issue `key` read again, with its text, before a chat starts from it. */
      issue(key: string): Promise<LinearSource>;
    };
  }
}
