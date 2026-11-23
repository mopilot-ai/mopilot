// window.native.momoDraft's types (a MoMo draft card, A3), merged into NativeApi; the calls are declared in electron/bridge/momoDraft.cjs.
import type {
  MomoDraft,
  MomoDraftOpened,
  MomoDraftSendInput,
  MomoDraftSent,
  MomoDraftState,
  MomoDraftStateEvent,
  MomoMailAccounts,
} from './contracts/momoDraft';

declare module '../native' {
  interface NativeApi {
    momoDraft: {
      /** open the user's mail app on a draft; it opens a compose window only and sends nothing */
      openInMail(draft: MomoDraft): Promise<MomoDraftOpened>;
      /** the connected mail accounts a draft can be sent from */
      accounts(): Promise<MomoMailAccounts>;
      /** send from the account the user chose, through the trust layer (its card, or a rule); answers when the send ended */
      send(input: MomoDraftSendInput): Promise<MomoDraftSent>;
      /** how far a draft note's send got */
      state(note: { chatId: string; noteId: string }): Promise<MomoDraftState>;
      onState(cb: (e: MomoDraftStateEvent) => void): () => void;
    };
  }
}
