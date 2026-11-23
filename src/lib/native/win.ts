// window.native.win's types (this window), merged into NativeApi; the calls are declared in electron/bridge/win.cjs.
export {};

declare module '../native' {
  interface NativeApi {
    win: {
      isFocused(): Promise<boolean>;
      toggleMaximize(): Promise<void>;
      /** Windows: colors of the window-controls overlay (minimize/maximize/close) */
      setTitleBarOverlay(color: string, symbolColor: string): Promise<void>;
      mini(): Promise<void>;
      miniShortcut(on: boolean): Promise<boolean>;
      quickChatRead(): Promise<{ threadId: string | null; text: string }>;
      quickChatSave(state: { threadId: string | null; text: string }): Promise<void>;
      quickChatOpen(threadId: string): Promise<{ ok: boolean; error?: string }>;
      quickChatSettings(section?: string): Promise<{ ok: boolean; error?: string }>;
      rendererReady(): void;
      miniHide(): Promise<void>;
      onMiniShown(cb: () => void): () => void;
      open(hash?: string): Promise<void>;
      onFocus(cb: (focused: boolean) => void): () => void;
      onFullscreen(cb: (fs: boolean) => void): () => void;
    };
  }
}
