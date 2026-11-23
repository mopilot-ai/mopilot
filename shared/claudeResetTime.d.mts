/**
 * Unix seconds of a reset the CLI printed in `zone` (the IANA name it adds in parentheses; this machine's when absent),
 * or null when the text is not one it prints. A date without a year is in the year it was printed (`printedAt`, ms).
 */
export function resetTime(text: string, zone: string | null | undefined, printedAt: number): number | null;
