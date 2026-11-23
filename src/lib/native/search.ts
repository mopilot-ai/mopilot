// window.native.search's types (file and text search), merged into NativeApi; the calls are declared in electron/bridge/search.cjs.
import type { FileMatch } from '../native';

declare module '../native' {
  interface NativeApi {
    /** File search over the bundled ripgrep (electron/platform/search.cjs); needs no harness. */
    search: {
      files(cwd: string, query: string, opts?: { limit?: number; dirs?: boolean }): Promise<{ files: FileMatch[] }>;
      /** The lines under `cwd` holding `query` (electron/platform/searchText.cjs), relative paths, `truncated` when more were left out. */
      text(
        cwd: string,
        query: string,
        opts?: { limit?: number },
      ): Promise<{ matches: { path: string; line: number; column: number; text: string }[]; truncated: boolean }>;
    };
  }
}
