// Turn navigation in a thread: stable message ids across reloads, the navigation entries and their anchors.

import type { TurnState } from '../store/types';
import { endCard, presentItems, turnCard } from '../harness/codexTranslate';
import { parseDelegation, parseUserText } from '../lib/format';
import { stripDirectives } from '../lib/codexDirectives';
import { basename } from '../lib/paths';
import { promptUuidOf } from '../harness/claudeTranslate';

import { splitTurn } from '../lib/asyncQuestions';

/** IDs, rather than positions, survive pagination and streaming updates. Scoped to a chat. */
export function navigationId(turnId: string, itemId: string, userIndex = 0) {
  // Claude's live ct-<uuid>/local-<uuid> becomes h-<uuid>/<uuid> on reload.
  // Follow-ups also acquire transcript IDs; their order within the same prompt stays stable.
  const uuid = promptUuidOf(turnId);
  return JSON.stringify(uuid ? [uuid, userIndex] : [turnId, itemId]);
}

export interface NavigationItem {
  id: string;
  prompt: string;
  response: string;
  outputs: string[];
  canBookmark: boolean;
  /** what find in the chat matches, in the order the turn draws it: the user's own words as typed, then (the last prompt's) the plan and the reply, Markdown */
  find: { said: string; replies: string[] };
}

/** Each turn's entries, by turn object: a finished turn keeps its object, so a streaming delta recomputes only its own turn. */
const byTurn = new WeakMap<TurnState, NavigationItem[]>();

function entriesOf(turn: TurnState): NavigationItem[] {
  let entries = byTurn.get(turn);
  if (!entries) byTurn.set(turn, (entries = turnNavigation(turn)));
  return entries;
}

export function navigationItems(turns: TurnState[]): NavigationItem[] {
  return turns.flatMap(entriesOf);
}

const sameEntry = (a: NavigationItem, b: NavigationItem) =>
  a === b ||
  (a.id === b.id &&
    a.prompt === b.prompt &&
    a.response === b.response &&
    a.canBookmark === b.canBookmark &&
    a.find.said === b.find.said &&
    a.find.replies.length === b.find.replies.length &&
    a.find.replies.every((text, i) => text === b.find.replies[i]) &&
    a.outputs.length === b.outputs.length &&
    a.outputs.every((output, i) => output === b.outputs[i]));

/** `previous` while `next` holds the same entries (a delta to the running turn recomputes its entries), else `next`. */
export function keepNavigation(previous: NavigationItem[], next: NavigationItem[]): NavigationItem[] {
  return previous.length === next.length && previous.every((entry, i) => sameEntry(entry, next[i])) ? previous : next;
}

/** One turn's entries, kept while the turn object is (find in the chat groups its matches by turn). */
export const turnEntries = entriesOf;

/** The id of the turn holding navigation entry `id`, or null when no turn of `turns` does. */
export function navigationTurn(turns: TurnState[], id: string): string | null {
  return turns.find((turn) => entriesOf(turn).some((entry) => entry.id === id))?.id ?? null;
}

function turnNavigation(turn: TurnState): NavigationItem[] {
  const running = turn.status === 'inProgress';
  const items = presentItems(turn.items);
  const card = endCard(turnCard(items, !!turn.planMode, running), items);
  const { final } = splitTurn(card ? items.filter((i) => i.id !== card.item.id) : items, running);
  const finalText = stripDirectives(String((final as { text?: string } | null)?.text ?? ''), true, { streaming: running }).trim();
  const response = card ? stripDirectives(String(card.kind === 'review' ? card.item.review : card.item.text), true).trim() : finalText;
  // a plan card draws its text before any reply; a review card draws findings, not its text, so find leaves it out
  const replies = [card?.kind === 'plan' ? response : '', finalText].filter(Boolean);
  const outputs = [
    ...new Set(
      items.flatMap((item) =>
        item.type === 'fileChange'
          ? (item.changes ?? []).map((change) => basename(change.path ?? '') || 'Edited file')
          : item.type === 'imageGeneration'
            ? ['Generated image']
            : [],
      ),
    ),
  ];
  const users = items.filter((item) => item.type === 'userMessage');
  return users.flatMap((item, index) => {
    const content = item.content ?? [];
    const parsed = parseUserText(
      content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n'),
    );
    const delegation = parseDelegation(parsed.text);
    if (delegation?.flush) return [];
    const text = stripDirectives(delegation?.input ?? parsed.text, true, { reply: false }).trim();
    const attachments = [
      ...content.filter((c) => c.type === 'image' || c.type === 'localImage').map(() => 'Image'),
      ...content.filter((c) => c.type === 'mention' || c.type === 'skill').map((c) => c.name || basename(c.path ?? '') || 'Attachment'),
      ...parsed.files.map((f) => f.name),
    ];
    const prompt =
      text || parsed.annotations.map((a) => a.annotation || a.text).join(' ') || parsed.selections.join(' ') || attachments.join(', ');
    if (!prompt) return [];
    const last = index === users.length - 1;
    const next = users[index + 1];
    const segment = items.slice(items.indexOf(item) + 1, next ? items.indexOf(next) : undefined);
    const ownReply = last
      ? response
      : stripDirectives(String((splitTurn(segment, running).final as { text?: string } | null)?.text ?? ''), true, {
          streaming: running,
        }).trim();
    return [
      {
        id: navigationId(turn.id, item.id, index),
        prompt,
        // The final answer follows the last prompt. Earlier follow-ups preview only their own replies.
        response:
          ownReply ||
          (last
            ? running
              ? 'Working…'
              : turn.error
                ? 'This turn ended with an error.'
                : turn.status === 'interrupted'
                  ? 'Stopped'
                  : 'No reply'
            : ''),
        outputs: last ? outputs : [],
        // an earlier follow-up's own reply sits in the folded work, not on screen, so find leaves it out
        find: { said: text, replies: last ? replies : [] },
        canBookmark: !turn.id.startsWith('pending-') && (!!promptUuidOf(turn.id) || !item.id.startsWith('local-')),
      },
    ];
  });
}

export function navigationAnchor(scroll: HTMLElement, id: string): HTMLElement | null {
  return [...scroll.querySelectorAll<HTMLElement>('[data-navigation-id]')].find((anchor) => anchor.dataset.navigationId === id) ?? null;
}
