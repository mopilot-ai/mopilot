// Types for the dependency-free main failure protocol consumed by scripts, the app and strict web compilation.
export const SCOPED_MARK: '(scoped:';
export function isScoped(description?: string | null): boolean;
export function issueMarker(body: string | null | undefined): {
  context: string;
  sha: string;
  files: string[] | null;
  tests?: string[];
} | null;
