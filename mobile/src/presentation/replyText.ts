// A reply's text as a person reads it, for selecting a range of it: its Markdown without the marks (paragraphs and headings as lines, a blank line between blocks, list items with their bullet or number, a table as tab-separated rows, a code block as it is).
import { parseMarkdown } from '../../../shared/markdownParse.mjs';

type Node = { type: string; value?: string; alt?: string | null; ordered?: boolean; start?: number | null; children?: Node[] };

/** The words an inline run holds: text and code as they are, an image as its description, a break as a new line. */
const words = (node: Node): string => {
  if (node.type === 'break') return '\n';
  if (node.type === 'image' || node.type === 'imageReference') return node.alt || '';
  return node.value ?? (node.children ?? []).map(words).join('');
};

export function textOf(node: Node): string {
  switch (node.type) {
    case 'code':
      return node.value!;
    case 'list':
      return node
        .children!.map((item, i) => `${node.ordered ? `${node.start! + i}.` : '•'} ${item.children!.map(textOf).join('\n')}`)
        .join('\n');
    case 'blockquote':
      return node.children!.map(textOf).join('\n\n');
    case 'table':
      return node.children!.map((row) => row.children!.map(words).join('\t')).join('\n');
    case 'thematicBreak':
      return '';
    default:
      return words(node);
  }
}

/** One block as plain text (a table as tab-separated rows), for copying it alone. */
export { textOf as blockText };

/** `markdown` as plain text to select from: its blocks one blank line apart. */
export function selectableText(markdown: string): string {
  const root = parseMarkdown(markdown) as unknown as Node;
  return root
    .children!.map(textOf)
    .filter((block) => block !== '')
    .join('\n\n');
}
