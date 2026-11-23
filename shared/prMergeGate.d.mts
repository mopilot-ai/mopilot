// The merge gate's contract: why a pull request cannot merge now, or null.
export interface MergeGatePr {
  state?: string;
  mergeable?: string;
  mergeState?: string;
  failed?: number;
  pending?: number;
}
export function mergeBlock(pr: MergeGatePr | null | undefined): { reason: string; message: string } | null;
