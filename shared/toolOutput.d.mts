// Shared inline tool-output contract for desktop renderers and main-process panel previews.
export function imageSrc(content: unknown): string | null;
export function toolOutput(call: unknown, skipText?: (text: string) => boolean): { text: string; images: string[] };
