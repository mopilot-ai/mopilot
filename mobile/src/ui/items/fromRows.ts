// Folds the phone's display blocks (the Mac path: rows, runs, cards, the turn's status) into the item union; total over every role the fold can produce, never throws.
import { authoredCardOf } from '../../components/AuthoredCard';
import type { Block, Kind, KeyedRow } from '../../presentation/toolRuns';
import { workingWords, type Tail } from '../../presentation/workingLine';
import type {
  ApprovalItem,
  CardOption,
  Item,
  MessageItem,
  PlanItem,
  QuestionItem,
  QuestionPrompt,
  StatusItem,
  StatusWord,
  ToolCallItem,
  ToolRunItem,
} from './types';

/** A card the Mac sent, as far as the items read it (the chat's `CardData` fits; this type keeps the UI-free mapper off the component's imports). */
export type CardData = {
  id: string | number;
  title: string;
  rev: number;
  detail?: string | null;
  to?: string;
  questions?: {
    id: string;
    question?: string;
    header?: string;
    options?: { label: string }[];
    isOther?: boolean;
    multiSelect?: boolean;
  }[];
  schema?: { properties?: Record<string, { title?: string; description?: string; enum?: unknown[]; enumLabels?: string[] }> };
  /** When the card began and the Host's reminder and pause times, from a Mac that sends them. */
  since?: number;
  remindMs?: number;
  pauseMs?: number;
  choices?: { key: string; label: string; deny?: boolean }[];
  kind?: string;
  plan?: { text: string; clipped?: boolean };
  where?: 'phone' | 'mac-only';
  waitingCopy?: string;
  viaMachine?: true;
};

/** What the turn is doing, for the status item at the end of the list. */
export type TurnInput = { turn: unknown; tail: Tail; sinceMs: number; error?: boolean; interrupted?: boolean };

export type FromRowsOptions = {
  /** Keys of your messages that did not go. */
  failed?: ReadonlySet<string>;
  /** The cards the Mac sent with the chat, as the chat holds them. */
  cards?: readonly CardData[];
  /** Whether earlier messages can be loaded, and whether that is under way. */
  earlier?: { loading: boolean } | null;
  turn?: TurnInput | null;
};

const stepOf = (row: KeyedRow): ToolCallItem => ({
  kind: 'tool-call',
  id: row.key,
  text: row.text,
  tool: row.kind ?? 'other',
  state: row.state ?? 'done',
  durationMs: row.ms ?? null,
  ...(row.detail ? { detail: row.detail } : {}),
  ...(row.thumbnail ? { thumbnail: row.thumbnail } : {}),
  ...(row.surface ? { surface: row.surface } : {}),
  ...(row.callId ? { callId: row.callId } : {}),
});

function messageOf(row: KeyedRow, from: 'user' | 'assistant', live: boolean, failed: ReadonlySet<string> | undefined): MessageItem {
  const authored = from === 'user' ? authoredCardOf(row.text) : null;
  const send = from === 'user' ? (failed?.has(row.key) ? 'failed' : row.optimistic ? 'pending' : undefined) : undefined;
  return {
    kind: 'message',
    id: row.key,
    from,
    text: row.text,
    live,
    ...(send ? { send } : {}),
    ...(row.clientId ? { clientId: row.clientId } : {}),
    ...(row.images ? { images: { count: row.images, ...(row.messageId ? { messageId: row.messageId } : {}) } } : {}),
    ...(row.pictures?.length ? { pictures: row.pictures } : {}),
    ...(authored ? { authored } : {}),
  };
}

/** One display row as one item. A role the fold does not make becomes `unknown`, so nothing disappears. */
export function itemOfRow(row: KeyedRow, failed?: ReadonlySet<string>): Item {
  switch (row.role) {
    case 'user':
      return messageOf(row, 'user', false, failed);
    case 'liveUser':
      return messageOf(row, 'user', true, failed);
    case 'assistant':
      return messageOf(row, 'assistant', false, failed);
    case 'preview':
      return messageOf(row, 'assistant', true, failed);
    case 'step':
    case 'live':
      return stepOf(row);
    default:
      return { kind: 'unknown', id: row.key, text: row.text };
  }
}

export function itemOfBlock(block: Block, failed?: ReadonlySet<string>): Item {
  if (block.type === 'row') return itemOfRow(block.row, failed);
  const run: ToolRunItem = {
    kind: 'tool-run',
    id: `run:${block.key}`,
    summary: block.summary,
    running: block.running,
    steps: block.steps.map(stepOf),
  };
  return run;
}

const cardId = (card: CardData) => JSON.stringify(['mac', card.id, card.rev]);

/** A Mac card's buttons: its choices; a card that offers none (a question) has none. */
const optionsOf = (card: CardData): CardOption[] =>
  (card.choices ?? []).map((c) => ({ id: c.key, label: c.label, tone: c.deny ? 'deny' : 'allow' }));

/** What a question card asks: its questions, or the fields of its form (a field with choices is a pick, one without is free text). */
function promptsOf(card: CardData): QuestionPrompt[] {
  const asked = (card.questions ?? []).map((q) => ({
    id: q.id,
    ...(q.header ? { header: q.header } : {}),
    text: q.question ?? q.header ?? '',
    options: (q.options ?? []).map((o) => ({ label: o.label })),
    multi: q.multiSelect === true,
    other: q.isOther === true || !q.options?.length,
  }));
  const fields = Object.entries(card.schema?.properties ?? {}).map(([id, f]) => {
    const options = (f.enumLabels ?? f.enum?.map(String) ?? []) as string[];
    return {
      id,
      ...(f.title ? { header: f.title } : {}),
      text: f.description ?? f.title ?? id,
      options: options.map((label) => ({ label })),
      multi: false,
      other: options.length === 0,
    };
  });
  return [...asked, ...fields];
}

/** A card the Mac sent: a plan, a question, or a permission request. */
export function itemOfCard(card: CardData): ApprovalItem | QuestionItem | PlanItem {
  const base = {
    id: cardId(card),
    origin: 'mac' as const,
    title: card.title,
    ...(card.detail ? { detail: card.detail } : {}),
    macOnly: card.where === 'mac-only',
    ...(card.waitingCopy ? { waitingCopy: card.waitingCopy } : {}),
    view: {
      state: 'waiting' as const,
      ...(card.since !== undefined ? { since: card.since } : {}),
      ...(card.remindMs !== undefined ? { remindMs: card.remindMs } : {}),
      ...(card.pauseMs !== undefined ? { pauseMs: card.pauseMs } : {}),
    },
  };
  if (card.kind === 'plan')
    return { ...base, kind: 'plan', options: optionsOf(card), text: card.plan?.text ?? '', clipped: card.plan?.clipped === true };
  const prompts = promptsOf(card);
  if (prompts.length) return { ...base, kind: 'question', prompts, questions: prompts.length };
  return { ...base, kind: 'approval', options: optionsOf(card), ...(card.to ? { destination: card.to } : {}) };
}

/** The catalog key of each activity the working line names, and of each stage of thinking (found by its English words, so the thresholds stay in `workingLine.ts`). */
const DOING_KEY: Record<Kind, StatusWord> = {
  read: 'reading',
  search: 'searching',
  edit: 'editing',
  run: 'running',
  web: 'searchingWeb',
  other: 'working',
};
const THINKING_KEY: Record<string, StatusWord> = {
  'Thinking…': 'thinking',
  'Thinking more…': 'thinkingMore',
  'Thinking some more…': 'thinkingSomeMore',
  'Still thinking…': 'stillThinking',
};

/** The status of a running or waiting turn; none when the turn is idle and nothing went wrong. */
export function statusOf(input: TurnInput): StatusItem | null {
  if (input.error) return { kind: 'status', id: 'status', state: 'error', wordKey: 'error', words: '' };
  if (input.interrupted) return { kind: 'status', id: 'status', state: 'interrupted', wordKey: 'interrupted', words: '' };
  if (input.turn === 'awaitingUser')
    return { kind: 'status', id: 'status', state: 'waiting', wordKey: 'waiting', words: 'Waiting for you' };
  if (input.turn !== 'running' && input.turn !== 'inProgress') return null;
  const words = workingWords(input.tail, input.sinceMs);
  const state = input.tail.type === 'reply' ? 'writing' : input.tail.type === 'step' ? 'working' : 'thinking';
  const wordKey = input.tail.type === 'step' ? DOING_KEY[input.tail.kind] : input.tail.type === 'reply' ? 'writing' : THINKING_KEY[words];
  return { kind: 'status', id: 'status', state, wordKey, words };
}

/** The whole list: earlier row, the blocks, the Mac's cards, the turn's status. */
export function itemsFromBlocks(blocks: readonly Block[], options: FromRowsOptions = {}): Item[] {
  const items: Item[] = [];
  if (options.earlier) items.push({ kind: 'earlier', id: 'earlier', loading: options.earlier.loading });
  for (const block of blocks) items.push(itemOfBlock(block, options.failed));
  for (const card of options.cards ?? []) items.push(itemOfCard(card));
  const status = options.turn ? statusOf(options.turn) : null;
  if (status) items.push(status);
  return items;
}
