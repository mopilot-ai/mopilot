// Types for the server's deterministic, device-bound refresh successors.
export function validRefreshOperation(value: unknown): value is string;
export function refreshSuccessor(token: string, deviceId: string, operation: string): string;
