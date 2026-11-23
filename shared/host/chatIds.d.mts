export function hostChatId(appId: string): string;
export function appChatId(hostId: string): string;
export function isHostFamily(harness: string): harness is 'claude' | 'codex';
export function appIdPrefix(harness: string): string;
export function hostFamilyOfHarness(harness: string): 'claude' | 'codex' | null;
export function agentOfKind(kind: unknown): string | null;
export function harnessOfHostChat(hostId: string): string;
