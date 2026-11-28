// window.native.previews' types (a chat's dev-preview servers for the session rail), merged into NativeApi; the calls are declared in electron/bridge/previews.cjs.

/** What the rail shows of one server: 'starting', 'ready', 'exited', 'failed' or 'stopped'. */
export type PreviewServer = { id: string; name: string | null; url: string | null; port: number | null; status: string; live: boolean };

declare module '../native' {
  interface NativeApi {
    previews: {
      list(chatId: string): Promise<PreviewServer[]>;
      /** false when previews are not running in this app */
      stop(chatId: string, id: string): Promise<boolean>;
      onChanged(cb: (e: { chatId: string }) => void): () => void;
    };
  }
}
