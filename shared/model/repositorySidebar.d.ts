// Draft and sidebar repository destination contracts shared by the window state and routing.
export type HostSidebarRepositoryQuery =
  | { path: string; fresh?: true; expectedHostKey?: string; checkout?: never }
  | { path: string; checkout: true; expectedHostKey?: string };

export type RepositoryDestination =
  | { kind: 'machine'; id: string; name: string; path: string; scope?: string }
  | { kind: 'cloud'; id: string; label: string };

type LocalDestination = { kind: 'local'; path: string; projectId: string | null };
export type DraftDestination = LocalDestination | RepositoryDestination;
export type RepositoryDraft = {
  key: string;
  name: string;
  repository: string;
  destinations: DraftDestination[];
  needsLocation: boolean;
};
