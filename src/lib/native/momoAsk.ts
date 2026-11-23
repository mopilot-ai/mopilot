// window.native.momoAsk's types (Ask MoMo in Quick Chat), merged into NativeApi; the calls are declared in electron/bridge/momoAsk.cjs. Each throws with a code: `not_allowed` while MoMo is off, `not_quick_chat` from any other window.
export {};

declare module '../native' {
  interface NativeApi {
    momoAsk: {
      /** MoMo's main chat, made when there is none */
      chat(): Promise<{ chatId: string }>;
      /** a message to MoMo's main chat only; the same id again never sends twice. `note`: queued with this error */
      send(item: { id: string; text: string; followUp?: 'queue' | 'steer' }): Promise<{ chatId: string; note: string | null }>;
      /** MoMo's chat in the app window; Quick Chat hides */
      open(): Promise<void>;
    };
  }
}
