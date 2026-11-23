// Markdown prose boundaries shared by message decoding and renderer transformations.
export function mapProse(md: string, fn: (prose: string) => string, code?: (code: string) => string, inline?: boolean): string;
export function maskMarkdownCode(md: string): string;
