// Types for the shared public stable update manifest and selector.
import type { RollbackPolicy, RollbackIntent } from './releaseRollback.cjs';
export type StableRelease = {
  version: string;
  platform: string;
  arch: string;
  rolloutPct: number;
  url: string;
  notes: string;
  pub_date: string;
  sha256?: string;
  size?: number;
};
export type StableManifest = {
  schema: 1;
  releases: StableRelease[];
  promotions?: StableRelease[];
  rollbacks?: RollbackPolicy[];
  linuxReleases?: StableRelease[];
};
export const STABLE_FEED_URL: string;
export function rolloutBucket(installId: string, salt?: string): number;
export function selectStableUpdate(
  manifest: unknown,
  context: { version: string; stagedVersion?: string; platform: string; arch: string; installId: string },
): { url: string; name: string; notes: string; pub_date: string; rollback?: RollbackIntent; sha256?: string; size?: number } | null;

export function isHttpsUrl(value: unknown): boolean;
