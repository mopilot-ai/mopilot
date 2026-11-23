// Public types for the dependency-free exact app-version comparison used by desktop and web.
export type VersionParts = { core: bigint[]; pre: string[] };
export function parseExactVersion(value: unknown): VersionParts | null;
export function compareVersionParts(x: VersionParts, y: VersionParts): number;
