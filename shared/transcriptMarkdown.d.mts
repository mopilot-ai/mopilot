// Types for shared/transcriptMarkdown.mjs: a chat as Markdown.
import type { TurnState } from './model/store';

export function transcriptMarkdown(title: string, turns: TurnState[], label?: (turn: number) => string): string;
