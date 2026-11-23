// The Conductor import as its pages say it: what is still to bring over, and what an import did.
import type { ConductorFound, ConductorImported } from './native/conductor';

/** "1 workspace", "3 repositories". */
export const counted = (n: number, one: string) => `${n} ${n === 1 ? one : one.endsWith('y') ? `${one.slice(0, -1)}ies` : `${one}s`}`;

export interface PendingRepo {
  repo: string;
  name: string;
  /** Workspaces not opened in place yet. */
  workspaces: number;
}

/** The repositories that still have a workspace to bring over, as discovery found them. */
export function pending(found: ConductorFound | null): PendingRepo[] {
  return (found?.repos ?? [])
    .map((r) => ({ repo: r.repo, name: r.name, workspaces: r.workspaces.filter((w) => !w.adopted).length }))
    .filter((r) => r.workspaces > 0);
}

/** "3 workspaces in 2 repositories". */
export function pendingText(repos: PendingRepo[]): string {
  const workspaces = repos.reduce((n, r) => n + r.workspaces, 0);
  return `${counted(workspaces, 'workspace')} in ${counted(repos.length, 'repository')}`;
}

export interface ImportFailure {
  /** The folder that failed: two repositories may share a name. */
  path: string;
  /** The repository's name, or `<repository>/<workspace>`. */
  name: string;
  error: string;
}

/** Every repository and workspace an import could not bring over, and why. */
export function failures(done: ConductorImported | null): ImportFailure[] {
  const out: ImportFailure[] = [];
  for (const r of done?.repos ?? []) {
    if (r.error) out.push({ path: r.repo, name: r.name, error: r.error });
    for (const w of r.workspaces) {
      if (w.status === 'failed') out.push({ path: w.path, name: `${r.name}/${w.name}`, error: w.error ?? 'It could not be opened.' });
    }
  }
  return out;
}

/**
 * What an import did, in one line: what was brought over, and how much was not. Main looks again when it imports, so
 * what was offered may be gone by then: that is "nothing found", not "already imported".
 */
export function importedText(done: ConductorImported): string {
  const all = done.repos.flatMap((r) => r.workspaces);
  const brought = all.filter((w) => w.status === 'adopted').length;
  const failed = failures(done).length;
  if (failed) return `${brought ? `Imported ${counted(brought, 'workspace')}` : 'Nothing was imported'}; ${failed} could not be imported`;
  if (brought) return `Imported ${counted(brought, 'workspace')}`;
  return all.length ? 'Everything was already imported' : 'Nothing was found to import';
}
