// window.native.layout's types (main's window tools asking this window to change its layout), merged into NativeApi; the calls are declared in electron/bridge/layout.cjs.
/** What a layout request reads back: the main pane, the side panes and the one focused. */
export type LayoutDescription = {
  main: { session_id: string } | { page: string };
  panes: { session_id: string; focused: boolean; opened_by_you: boolean }[];
  focused: string;
};
/** The answer to a layout request: what happened, and the layout or the pane's tab when the request asked. */
export type LayoutReply = { outcome: string; layout?: LayoutDescription; tab_id?: string };

declare module '../native' {
  interface NativeApi {
    layout: {
      onRequest(cb: (id: number, req: unknown) => void): () => void;
      reply(id: number, answer: LayoutReply): void;
    };
  }
}
