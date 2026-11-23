/** Strip the `/bin/zsh -lc "..."` wrapper Codex puts around shell commands. */
export function prettyCommand(cmd: string): string;
export type ResponseAnnotation = {
  text: string;
  annotation?: string;
  /** a diff comment's file, its `Lines:` and `Side:` (text is then its diff hunk) */
  file?: { path: string; lines: string; side: string };
};
export type ParsedUserText = {
  text: string;
  questionReply?: { question: string; annotationIndex: number };
  annotations: ResponseAnnotation[];
  files: {
    name: string;
    path: string;
  }[];
  selections: string[];
  /** the Chrome tab the side panel was on when the message was sent from it (its address), shown apart from the text */
  chromeTab?: string;
};
/**
 * The official app prepends context sections to user messages — `<in-app-browser-context>`,
 * `# Chrome tabs:`, `# Files mentioned by the user:`, `# Response annotations:`, `# Diff comments:`,
 * `# Selected text:` — followed by a `## My request:` header. Recover what the user typed, plus the
 * annotations (diff comments among them, with their file), files and selected-text snippets.
 */
export function parseUserText(raw: string): ParsedUserText;
/**
 * Quote-replies from Claude desktop: a `<!-- reply N -->` marker line followed by `>` quote lines.
 * Each quote becomes an annotation; with several quotes, the text after a quote (up to the next
 * marker) is that quote's comment, and the text after the last quote is the message itself.
 * Plain Markdown quotes without a marker are left alone.
 */
export function extractReplyQuotes(raw: string): {
  text: string;
  annotations: ResponseAnnotation[];
} | null;
/** A message without the blocks the app sends ahead of the user's own text for the agent alone. */
export function withoutHiddenBlocks(raw: string): string;
