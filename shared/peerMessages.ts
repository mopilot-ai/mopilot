// The peer messaging types shared by main, the windows and the agent tools: messages, delivery states and capabilities.

/** Shared IPC/tool presentation contract. Native protocol decisions stay in main adapters. */
export type PeerDelivery =
  | 'accepted'
  | 'queued'
  | 'submitting'
  | 'delivered'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'uncertain'
  /** waiting for the receiving user's Allow: the chats' permission modes differ (electron/session/peerHold.cjs) */
  | 'held'
  | 'declined'
  | 'expired';
export type PeerReplyState = 'notRequested' | 'awaiting' | 'received' | 'timedOut';
export type PeerMessage = {
  id: string;
  sourceChatId: string;
  targetChatId: string;
  /** each chat's title when it was sent: names an archived chat, which no window lists */
  sourceTitle?: string | null;
  targetTitle?: string | null;
  sourceTurnId: string | null;
  temporary?: boolean;
  body: string;
  conversationId: string;
  replyTo: string | null;
  delivery: PeerDelivery;
  reply: PeerReplyState;
  createdAt: number;
  targetTurnId: string | null;
  targetNativeId: string | null;
  targetItemId?: string | null;
  targetKind?: string;
  errorCode: string | null;
  replyMessageId?: string;
  /** the chats this message's agent-to-agent chain passed through, ending with its sender */
  hops?: string[];
  /** a held message: when it expires undelivered */
  heldUntil?: number;
  /** the receiving user allowed it past the hold */
  allowedByUser?: boolean;
};
export type PeerSendRequest = {
  targetChatId: string;
  requestId: string;
  body: string;
  requestReply?: boolean;
};
export type PeerCapabilities = {
  peerMessaging: { available: boolean; reason: string | null };
  peerRead: { available: boolean; reason: string | null };
  peerSteer: { available: boolean; reason: string | null };
  peerTools: { available: boolean; reason: string | null };
};
export type PeerAdapterCapabilities = {
  messaging: boolean;
  read: boolean;
  steer: boolean;
  toolChannel?: string;
};
export type PeerChat = {
  id: string;
  title: string;
  archived: boolean;
  state: string;
  project: string | null;
  capabilities: PeerCapabilities;
};
