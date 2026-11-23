// Types of shared/momoBriefNote.mjs.
export interface BriefCard {
  id: string;
  title: string;
  source: string;
}
export function briefCardOf(raw: unknown): BriefCard | null;
