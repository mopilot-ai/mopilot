// window.native.fs's types (local file helpers), merged into NativeApi; the calls are declared in electron/bridge/fs.cjs.
export {};

declare module '../native' {
  interface NativeApi {
    fs: {
      exists(p: string): Promise<boolean>;
      /** The file or folder a path in a reply names ("~" is home, a relative path is in `cwd`), or null when nothing is there. */
      messagePath(text: string, cwd: string | null): Promise<{ path: string; kind: 'file' | 'dir' } | null>;
      /** Make <root>/<date>/<slug> for a projectless chat. */
      mkdirProjectless(root: string, date: string, slug: string): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
      readText(p: string): Promise<string | null>;
      /** A bounded PDF/Office read; legacy DOC/PPT return text rather than byte data. */
      readPreview(p: string): Promise<{ kind: 'binary'; data: Uint8Array } | { kind: 'text'; text: string }>;
      /** Write a text file (atomically, through symlinks), with or without a harness running. */
      writeText(p: string, text: string): Promise<{ ok: boolean; error?: string }>;
      /** $CODEX_HOME and the Claude CLI's config folder, as main sees them. */
      configRoots(): Promise<{ home: string; codexHome: string; claudeRoot: string }>;
      /** A folder's entries (empty when unreadable): the file tree and the automations list, with no harness running. */
      readDir(p: string): Promise<{ fileName: string; isDirectory: boolean }[]>;
      remove(p: string): Promise<{ ok: boolean; error?: string }>;
      readImageDataUrl(p: string): Promise<string | null>;
      saveTempImage(dataUrl: string): Promise<string | null>;
      pathForFile(f: File): string;
    };
  }
}
