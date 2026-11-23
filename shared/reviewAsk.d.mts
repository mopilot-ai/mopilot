// Types for shared/reviewAsk.mjs: a review ask's words, and whether a prompt is one.
export declare function claudeReviewPrompt(
  target: { type: string; branch?: string; sha?: string; title?: string | null; instructions?: string } | null | undefined,
): string;
export declare function isReviewAsk(text: unknown): boolean;
