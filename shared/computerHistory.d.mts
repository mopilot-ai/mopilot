export declare const BUILT_IN_BROWSER: Readonly<{ bundleId: 'mopilot:built-in-browser'; name: 'Built-in browser' }>;
export declare const HISTORY_TAG: 'sage-computer-history';
export declare const HISTORY_CONTEXT_KEY: 'mopilot.computer-history';
export declare function isHistoryBlock(text: unknown): boolean;
export declare function historyContext(attachments?: readonly { kind?: string; text?: string; [key: string]: unknown }[]): string | null;
export declare function withComputerHistory(
  prompt: string,
  attachments?: readonly { kind?: string; text?: string; [key: string]: unknown }[],
): string;
export declare function stripHistoryBlocks<T>(text: T): T;
