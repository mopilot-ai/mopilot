// The last code block of a chat's transcript, for "Copy last code block": read from the page where its turn renders,
// and from the turn's replies where a long thread shows the turn as a placeholder.

import { fromMarkdown } from 'mdast-util-from-markdown';

interface Turn {
  id: string;
  items: { type: string; text?: unknown }[];
}
interface CodeNode {
  type: string;
  value?: string;
  children?: CodeNode[];
}

/**
 * The text of the last code block in `view` (a chat's thread view), turn by turn from the end: a rendered turn's
 * last `pre code`, or, for a turn shown as a placeholder, the last fenced or indented code block of its replies.
 * Null when there is none. `turns` (the chat's turns) is read only when a placeholder is reached.
 */
export function lastCodeBlock(view: ParentNode, turns: () => readonly Turn[]): string | null {
  const slots = view.querySelectorAll<HTMLElement>('[data-turn-slot]');
  let byId: Map<string, Turn> | null = null;
  for (let i = slots.length - 1; i >= 0; i--) {
    const slot = slots[i];
    if (slot.childElementCount) {
      const code = lastRendered(slot);
      if (code !== null) return code;
      continue;
    }
    byId ??= new Map(turns().map((turn) => [turn.id, turn]));
    const turn = byId.get(slot.dataset.turnSlot!);
    const code = turn ? lastInReplies(turn) : null;
    if (code !== null) return code;
  }
  return slots.length ? null : lastRendered(view);
}

function lastRendered(root: ParentNode): string | null {
  const blocks = root.querySelectorAll('pre code');
  return blocks.length ? blocks[blocks.length - 1].textContent : null;
}

function lastInReplies(turn: Turn): string | null {
  for (let i = turn.items.length - 1; i >= 0; i--) {
    const item = turn.items[i];
    if (item.type !== 'agentMessage' || typeof item.text !== 'string') continue;
    const code = lastCode(fromMarkdown(item.text));
    if (code !== null) return code;
  }
  return null;
}

function lastCode(node: CodeNode): string | null {
  for (let i = (node.children?.length ?? 0) - 1; i >= 0; i--) {
    const found = lastCode(node.children![i]);
    if (found !== null) return found;
  }
  // a code node always has its text as `value` (mdast)
  return node.type === 'code' ? String(node.value) : null;
}
