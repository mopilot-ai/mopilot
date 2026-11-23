import type { Root } from 'mdast';

/** The tree of a Markdown text: tables, strikethrough, bare URLs and emphasis next to CJK punctuation as the Mac reads them. */
export function parseMarkdown(text: string): Root;

/** The web and mail addresses in a text that is not Markdown (your own message): where each is, and what it opens. */
export function bareLinks(text: string): { start: number; end: number; url: string }[];
