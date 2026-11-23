// Types for shared/quotedReply.mjs.
export function quoteBlocks(text: string): { blocks: string[]; rest: string } | null;
export function splitQuote(text: string): { quote: string; rest: string } | null;
