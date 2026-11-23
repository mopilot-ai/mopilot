// window.native.conductor's types (importing from Conductor), merged into NativeApi; the calls are declared in electron/bridge/conductor.cjs.
export {};

/** A Conductor workspace found on disk: a git worktree, with the branch it has checked out now. */
export interface ConductorWorkspace {
  path: string;
  name: string;
  branch: string | null;
  /** Already adopted as a managed worktree. */
  adopted: boolean;
}

export interface ConductorFound {
  /** By the repository git says each workspace belongs to. */
  repos: { repo: string; name: string; workspaces: ConductorWorkspace[] }[];
  /** Folders found beside the workspaces that are not usable worktrees, and why. */
  skipped: { path: string; reason: string }[];
  /** More folders were there than one discovery looks at. */
  truncated: boolean;
}

export interface ConductorImported {
  repos: {
    repo: string;
    name: string;
    /** Absent when the repository could not be added as a project (`error` says why). */
    projectId?: string;
    /** False when it was a project already. */
    added?: boolean;
    error?: string;
    workspaces: { path: string; name: string; branch?: string | null; status: 'adopted' | 'already' | 'failed'; error?: string }[];
  }[];
  skipped: ConductorFound['skipped'];
  truncated: boolean;
}

declare module '../native' {
  interface NativeApi {
    conductor: {
      /** What Conductor left on this machine; reads only. */
      discover(): Promise<ConductorFound>;
      /** Add the found repositories as projects and adopt their workspaces in place (`only`: these repositories). Safe to repeat. */
      import(only?: string[]): Promise<ConductorImported>;
    };
  }
}
