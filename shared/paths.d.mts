/** Drive-letter (C:\, C:/, C:) or UNC (\\server\share) path. */
export const isWinPath: (p: string) => boolean;
/** A Windows path's comparable form: lower-cased, '\\' separators, no trailing one. */
export const winPathKey: (p: string) => string;
export function basename(p: string): string;
/** The last `depth` parent folders of `p`, to tell two same-named projects apart ("work/api"). */
export function parentHint(p: string, depth: number): string;
/** What tells projects of one name apart (the last parent folders of each, as many as it takes); only a shared name gets hints. */
export function projectHints(projects: { id: string; name: string; path?: string | null }[]): Map<string, string>;
