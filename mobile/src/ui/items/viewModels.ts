// The view-models the new phone components take as props (plan R1): data and callbacks only, so Orca-derived components never see the runtime, the fold or a wire type.
import type { CardOption, Item, StatusItem } from './types';

/** The chat's rows, top to bottom, with the turn's status last. */
export type TranscriptVM = {
  chatId: string;
  items: Item[];
  /** Rows came from the saved copy; the Mac's have not arrived yet. */
  cached: boolean;
  /** Anchor the list by this item id when earlier rows are added above it. */
  anchorId: string | null;
  loadEarlier: () => void;
  answerCard: (itemId: string, optionId: string) => void;
  /** Answers of a question card by prompt id: free text is a string, a multiple choice is the array. */
  answerQuestion: (itemId: string, answers: Record<string, string | string[]>) => void;
  /** Tries a card's answer again (an unreachable card, or one a restarted Host lost). */
  retryCard: (itemId: string) => void;
  /** A code block's Copy. */
  copyText: (text: string) => void;
  /** A picture in a message was tapped: its uri and its alt text. */
  openImage: (uri: string, alt: string) => void;
  retrySend: (itemId: string) => void;
  openLink: (url: string) => void;
};

/** One message waiting for its turn: it can be edited or taken back. */
export type QueuedMessage = { id: string; text: string; images: number };
/** A picture or file about to go with a message. */
export type AttachmentView = { id: string; kind: 'image' | 'file'; name: string; uri?: string; state: 'ready' | 'uploading' | 'failed' };
/** The model pill: what the chat runs on. */
export type ModelView = { label: string; effort?: string; harness: string; account?: string };

export type ComposerVM = {
  text: string;
  placeholder: string;
  /** Send is available: there is text or an attachment and nothing blocks it. */
  canSend: boolean;
  /** A turn runs: Stop replaces Send. */
  running: boolean;
  /** Why sending waits ("Your Mac is asleep."), when it does. */
  hold?: string;
  queued: QueuedMessage[];
  attachments: AttachmentView[];
  model: ModelView;
  permission: { label: string; options: CardOption[] };
  setText: (text: string) => void;
  send: () => void;
  stop: () => void;
  editQueued: (id: string, text: string) => void;
  removeQueued: (id: string) => void;
  removeAttachment: (id: string) => void;
};

/** A machine the chat runs on, as the header and the machine page show it. */
export type HostStatusVM = {
  name: string;
  state: 'connected' | 'asleep' | 'away' | 'unreachable';
  /** How the phone reaches it: straight, through the paired Mac, or not at all. */
  reach: 'direct' | 'through' | 'none';
  waiting: number;
};

/** The terminal of a chat (second round): the engine's input and output, nothing about the wire. */
export type TerminalVM = {
  state: 'connecting' | 'live' | 'closed' | 'failed';
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  /** Output the engine has drawn, acknowledged so the computer does not outrun the phone. */
  ack: (bytes: number) => void;
};

/** The status item of a turn, for a header or a list that shows it outside the transcript. */
export type TurnStatusVM = Pick<StatusItem, 'state' | 'words'>;

/** MoMo's header and page state: the words of its status and what needs the person. */
export type MomoVM = {
  name: string;
  status: 'online' | 'paused' | 'offline';
  needsYou: number;
  /** The Mac is away: messages wait on this phone until it is back. */
  macAway: boolean;
  /** How many messages wait for the Mac. */
  waiting: number;
};
