// Kind spelling reader: family and basic harness of 'codex', 'claude' or 'acp:<id>[:thread]'.
export type HarnessFamily = 'codex' | 'claude' | 'acp';
export function parseKind(kind: unknown): { family: HarnessFamily; basic: string | null } | null;
