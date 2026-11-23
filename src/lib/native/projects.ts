// window.native.projects's types (the project list), merged into NativeApi; the calls are declared in electron/bridge/projects.cjs.
import type { ProjectsSnapshot, LocalProject } from '../native';

declare module '../native' {
  interface NativeApi {
    /** userData/projects.json, owned by main */
    projects: {
      list(): Promise<ProjectsSnapshot>;
      /** Filesystem identities for navigation only; saved paths and chat cwd remain unchanged. */
      canonicalPaths(paths: string[]): Promise<Record<string, string>>;
      /** Local directory read/traversal access; null is unknown. Does not mutate saved projects or restore worktrees. */
      folderAvailability(paths: string[]): Promise<Record<string, boolean | null>>;
      add(opts: { path: string; name?: string; codexId?: string }): Promise<string | null>;
      /** attach a native copy only while the original local project still exists */
      linkCodex(id: string, codexId: string): Promise<LocalProject | null>;
      remove(id: string): Promise<void>;
      rename(id: string, name: string): Promise<void>;
      move(id: string, beforeId: string | null): Promise<void>;
      /** merge Codex's project/list (one way: Codex -> local) */
      importCodex(list: unknown[]): Promise<ProjectsSnapshot>;
      /** record that the import failed (shown, and retried at the next launch) */
      importFailed(message: string): Promise<ProjectsSnapshot>;
      /** the first import while Codex isn't running: main asks a short-lived app-server */
      importCodexBackground(): Promise<ProjectsSnapshot>;
      onChanged(cb: (snap: ProjectsSnapshot) => void): () => void;
    };
  }
}
