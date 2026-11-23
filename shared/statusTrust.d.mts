// Types for the shared runtime CI identity policy, including strict consumers that do not compile JavaScript.
export type Posted = {
  context?: string;
  state: string;
  creator?: { login?: string | null; __typename?: string | null } | null;
};
export const STATUS_CREATORS: readonly string[];
export const RESERVATIONS: readonly string[];
export function creatorLogin(creator: Posted['creator']): string;
export function counts(status: Posted, creators?: readonly string[]): boolean;
export function trusted<T extends Posted>(statuses: T[], creators?: readonly string[]): T[];
