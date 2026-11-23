// Canonical GitHub pull-request URL contract.
export function pullRequestUrl(value: unknown): string | null;
export function recordedBeforeMopilotReuse(recordedAt?: number | null): boolean;
export function movedMopilotPullRequestUrl(url: string): string;
export function isMopilotPullRequestUrl(url: string): boolean;
export function historicalPullRequestUrl(url: string, recordedAt?: number | null): string;
