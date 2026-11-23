// window.native.momoHome's types (MoMo's home, electron/bridge/momoHome.cjs), merged into NativeApi. Everything it returns is untrusted until the renderer parses it (src/components/momo/home/parseView.ts).
export {};

declare module '../native' {
  interface NativeApi {
    momoHome: {
      /** the whole view: `{ ok: true, view, movedAwayTo? }`, or `{ ok: false, reason, cause }` */
      view(): Promise<unknown>;
      /** one intent: `{ ok: true, view? }`, or `{ ok: false, cause, fix?, fixLabel? }` */
      intent(intent: unknown): Promise<unknown>;
      onChanged(cb: (payload: unknown) => void): () => void;
      /** whether this is a dev run (unpackaged, MOPILOT_MOMO_DEV=1): fixtures and the scripted home may be shown */
      dev(): Promise<boolean>;
      /** dev run only: switches the scripted home's scenario; false when there is none */
      devScenario(name: string): Promise<boolean>;
      /** dev run only: the scripted home refuses the next intent of `kind` once, with this cause and fix; false when there is no such home */
      devRefuse(kind: string, cause: string, fix?: unknown, fixLabel?: string): Promise<boolean>;
      /** dev run only: what the scripted home answers when asked after this turn (`has`, `missing` or `unknown`); false when there is no such home */
      devTurnAnswer(turnId: string, answer: string): Promise<boolean>;
      /** dev run only: lets the scripted home's held move go on */
      devRelease(): Promise<boolean>;
      /** dev run only: shows this whole view (null: back to the scripted home's) and tells every window; false outside a dev run */
      devSetView(view: unknown): Promise<boolean>;
    };
  }
}
