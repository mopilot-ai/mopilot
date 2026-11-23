import { type GoogleAccount } from './account.mjs';
export type OutgoingMessage = {
  to: string[];
  cc?: string[];
  subject: string;
  body: string /** Set for a reply: Gmail keeps it in the thread. */;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
};
export type SendResult =
  | {
      ok: true;
      id: string;
    }
  | {
      ok: false;
      reason: 'not_granted' | 'no_permission' | 'needs_sign_in' | 'invalid' | 'failed';
    };
/** A digest of what will be sent, so a grant for one mail cannot send another. */
export declare function messageDigest(m: OutgoingMessage): string;
/**
 * The grant book. `mint` belongs to the approval gate alone (the Host wires it only there); the sender gets `redeem`, which
 * consumes a grant: one use, for the message it was minted for, within ten minutes.
 */
export declare function createSendGrants(now: () => number): {
  mint(digest: string): string;
  redeem(grant: string, digest: string): boolean;
};
export type Sender = {
  /** Whether sending was granted by the user (the optional second consent). */
  canSend(): Promise<boolean>;
  send(message: OutgoingMessage, grant: string | undefined): Promise<SendResult>;
};
export declare function createSender(o: {
  account: GoogleAccount;
  redeem: (grant: string, digest: string) => boolean;
  endpoint: string;
}): Sender;
