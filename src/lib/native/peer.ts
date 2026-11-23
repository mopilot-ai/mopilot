// window.native.peer's types (chat-to-chat messages), merged into NativeApi; the calls are declared in electron/bridge/peer.cjs.
import type { PeerCapabilities, PeerChat, PeerMessage, PeerSendRequest } from '../../../shared/peerMessages';
import type { TurnState } from '../../../shared/model/store';

declare module '../native' {
  interface NativeApi {
    /** scheduled tasks: main starts every run (electron/platform/automationRun.cjs), the scheduler's and Run now */
    peer: {
      snapshot(source: string): Promise<PeerMessage[]>;
      capabilities(source: string): Promise<PeerCapabilities>;
      /** assistantOnly retains actual completed replies without the reference attachment's whole-turn excerpt limit. */
      /** `source`: the chat the reference is made from (a MoMo chat reads none); none outside a chat */
      referenceHistory(
        ids: string[],
        assistantOnly?: boolean,
        source?: string | null,
      ): Promise<Record<string, { turns: TurnState[]; earlierContentOmitted: boolean }>>;
      directory(
        source: string,
        args?: { query?: string; cursor?: string | null; limit?: number },
      ): Promise<{ chats: PeerChat[]; nextCursor: string | null }>;
      send(source: string, request: PeerSendRequest): Promise<PeerMessage>;
      reply(source: string, request: { messageId: string; requestId: string; body: string }): Promise<PeerMessage>;
      cancel(source: string, id: string): Promise<PeerMessage>;
      sendNow(source: string, id: string): Promise<PeerMessage>;
      resume(source: string, id: string): Promise<PeerMessage>;
      reconcile(source: string, id: string): Promise<PeerMessage>;
      /** the receiving chat's user allows or declines a held message */
      approve(source: string, id: string): Promise<PeerMessage>;
      decline(source: string, id: string): Promise<PeerMessage>;
      onChanged(cb: () => void): () => void;
    };
  }
}
