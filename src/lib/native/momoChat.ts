// Typed MoMo main chat bridge (electron/bridge/momoChat.cjs): each call throws `not_allowed` while MoMo is off.
import type { MomoActivityItem, MomoBrain, MomoBrainChange, MomoMainChatInfo, MomoPreviousChat } from './contracts/momoChat';

declare module '../native' {
  interface NativeApi {
    momoChat: {
      /** null before a brain is picked (the main chat's first start picks the default) */
      getBrain(): Promise<MomoBrain | null>;
      mainChat(): Promise<MomoMainChatInfo>;
      /** MoMo says hello in its main chat (setup's last step); false when it already did */
      greet(): Promise<boolean>;
      /** setup's Notifications row: one MoMo notice, through which macOS asks for notification permission (#2607) */
      enableNotices(): Promise<boolean>;
      /** MoMo's brain changed (in any window): read it again */
      onBrainChanged(cb: (brain: MomoBrain | null) => void): () => void;
      /** MoMo's routine runs and errands, newest first and bounded (what a phone's Activity list shows) */
      activityList(): Promise<{ items: MomoActivityItem[] }>;
      /** this window shows MoMo's activity (or no longer does): it is told of changes only while it does */
      watchActivity(on: boolean): Promise<boolean>;
      /** an activity item changed (its id): read the list again */
      onActivityChanged(cb: (change: { id: string }) => void): () => void;
      /** MoMo's earlier main chats, newest first */
      previousChats(): Promise<MomoPreviousChat[]>;
      /** an effort left out keeps the one MoMo has, where the new model offers it (else that model's default) */
      setBrain(
        brain: Pick<MomoBrain, 'harness' | 'account' | 'model'> & { modelLabel?: string | null; effort?: string | null },
      ): Promise<MomoBrainChange>;
      /** a model picked in a MoMo chat's composer: the brain's for the main chat, the chat's own for another (#2304) */
      setChatModel(
        chatId: string,
        model: string,
        label?: string | null,
      ): Promise<{ chatId: string; model: string; warning: string | null }>;
    };
  }
}
