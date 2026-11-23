// Mobile UI boundary: account, paired computer, connection state and harness-neutral remote requests.
import type { RemoteMessage } from '../../shared/remote/transport.mjs';
import type { PresenceMap } from './presence';
import type { ReconnectState } from './reconnect';
import type { QueuedSend } from './outbox';
export type { FirstMessage } from './presentation/sentMessages';

export type MobilePair = { pairId: string; macId: string; name?: string };
export type MobileSnapshot = {
  generation: number;
  phase: 'loading' | 'signedOut' | 'ready' | 'pairing' | 'offline' | 'online' | 'error';
  user: { id: string; name?: string; email?: string } | null;
  pairs: MobilePair[];
  selectedPair: string | null;
  safetyNumber: string | null;
  pendingPair: boolean;
  pairCleanup: boolean;
  /** The phone is walking its counters forward to a computer that is far ahead of it. */
  catchingUp?: boolean;
  pairingCommit?: boolean;
  error: string | null;
  /** Why the relay is turning this phone away, while it is (it is full, the account has its most devices connected, or the account's access is switched off); the words are in `error`. */
  refusal?: 'capacity' | 'account_limit' | 'disabled' | null;
  /** What the relay last said of each paired computer: online, asleep or unreachable, and when it was last seen. */
  presence: PresenceMap;
  /** Set while the phone is bringing a computer back by itself: which one, how many tries failed, when the next starts. */
  reconnect: ReconnectState;
  /** Messages typed for a chat that have not been accepted by the computer yet, oldest first. */
  outbox: QueuedSend[];
};

export interface MobileRuntime {
  /** The phone's own paths to its Hosts, once the vault is open (X3); null before, and in a runtime without them. */
  readonly direct?: import('./remote/directHosts').DirectHosts | null;
  snapshot(): MobileSnapshot;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** Deletes the account at the account service (`confirm` is the account's email); the app then signs out like Sign out does. */
  /** The closed-alpha features this account was invited to (Mobile Remote and Host no longer need one); null when the service doesn't say. */
  features(): Promise<string[] | null>;
  deleteAccount(confirm: string): Promise<void>;
  pair(qr: string, name: string): Promise<void>;
  cancelPairing(): Promise<void>;
  connect(pairId: string): Promise<void>;
  /** Forget a paired computer: tell the relay (best effort, bounded), then delete its keys here for good. */
  unpair(pairId: string): Promise<void>;
  disconnect(): void;
  /** Register or replace this phone's APNs/FCM token with the relay, or remove it, on the one authenticated socket. */
  pushRegister(platform: 'apns' | 'fcm', token: string): Promise<void>;
  pushUnregister(): Promise<void>;
  /** Register or remove the push-to-update token of this phone's running Live Activity (the relay sends it to Apple). */
  activityRegister(token: string): Promise<void>;
  activityUnregister(): Promise<void>;
  /**
   * Sends a message to a chat: at once when the computer is connected, otherwise when it is back, in order and exactly once (one send id
   * per message). `skills` ride beside the text (a Codex chat's skills). Returns that id; the message shows in `snapshot().outbox` until the computer accepted it.
   */
  messageIdentity?(method: 'chat.send' | 'chat.start', chatId: string | null, id: string): string | undefined;
  send(chatId: string, text: string, attachments?: string[], skills?: string[], momo?: true, pictures?: string[]): string;
  /** Takes back a message that has not gone out (queued or refused); false when it is in flight or gone. */
  cancelSend(id: string): boolean;
  /** Rewrites a message that is still waiting for the computer, in place; false when it is in flight, refused, gone or the text is empty. */
  editSend(id: string, text: string): boolean;
  /** Sends a refused message again under the same id. */
  retrySend(id: string): boolean;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (event: RemoteMessage) => void): () => void;
}
