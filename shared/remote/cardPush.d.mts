// Types for shared/remote/cardPush.mjs.
import type { Primitives } from './crypto.mjs';

export const MAX_CARD_BLOB_BYTES: number;
export const DETAIL_LEVELS: readonly string[];
export const CARD_STATES: readonly string[];
export const CARD_TOOLS: readonly string[];
export function toolPhrase(tool: string): string;
export function opensApp(tool: string): boolean;
export interface CardText {
  machine?: string;
  tool?: string;
  line?: string;
  stat?: string;
  question?: boolean;
  state?: string;
}
export interface OpenedCard {
  requestId: string;
  rev: number;
  card: CardText;
}
export function createCardPush(prim: Primitives): {
  cardKey(pairRoot: Uint8Array): Uint8Array;
  seal(o: { key: Uint8Array; ref: string; requestId: string; rev: number; detail: string; card: CardText; state?: string }): string | null;
  open(o: { sealed: string; ref: string; keys: Uint8Array[] }): OpenedCard | null;
};
export function cardText(card: CardText): { title: string; body: string };
