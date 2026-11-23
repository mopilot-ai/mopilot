export type OwnLine = { doing: string; done: string; failed: string };
/** MoPilot's own tools by name: the line each reads as while it runs, once done and when it failed. */
export const OWN_LINES: Readonly<Record<string, OwnLine>>;
