// Types for shared/remote/transport.mjs.
export type Presence = 'online' | 'sleeping' | 'gone';
export type RemoteMessage = {
  id: string;
  t: number;
  kind: 'request' | 'reply' | 'event' | 'ack';
  method?: string;
  params?: unknown;
  inReplyTo?: string;
  ok?: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  ev?: string;
  chatId?: string;
  rev?: number;
  feedSeq?: number;
  live?: boolean;
  turnId?: string | null;
  started?: boolean;
  patch?: unknown;
};
export type RemoteTransport = {
  send(pairId: string, msg: RemoteMessage): Promise<void>;
  onMessage(fn: (pairId: string, msg: RemoteMessage) => void): () => void;
  pairs(): string[];
  onPairsChanged(fn: (pairs: string[]) => void): () => void;
  presence(pairId: string): Presence;
};
export type MemoryPhone = {
  send(msg: RemoteMessage): Promise<void>;
  onMessage(fn: (msg: RemoteMessage) => void): () => void;
};
export function createMemoryLink(): {
  mac: RemoteTransport;
  addPair(pairId: string, presence?: Presence): void;
  removePair(pairId: string): void;
  setPresence(pairId: string, presence: Presence): void;
  phone(pairId: string): MemoryPhone;
};
