// window.native.codePair's types (this Mac's side of pairing by a code, R2b of #5576), merged into NativeApi; the calls are declared in electron/bridge/codePair.cjs and answered by main (agreed with the Host lane on #5576).
export type CodePairError = { error: { code: string; message?: string } };
export type CodePairStatus = {
  approval: { available: boolean; reason?: 'no_approval_helper' | 'unsupported_platform'; weak?: boolean };
  connections: boolean;
  offers: { offerId: string; phase: CodePairPhase; expiresAt: number }[];
};
export type CodePairPhase =
  | 'waiting'
  | 'connecting'
  | 'proving'
  | 'confirm'
  | 'done'
  | 'denied'
  | 'used_up'
  | 'expired'
  | 'cancelled'
  | 'failed';
/** One step of a run: `confirm` carries the other Mac's name, the safety number and how long the person has; `done` the new client's fingerprint; `failed` its code. */
export type CodePairEvent = {
  offerId: string;
  phase: CodePairPhase;
  name?: string;
  safety?: string;
  expiresInMs?: number;
  fingerprint?: string;
  code?: string;
};

declare module '../native' {
  interface NativeApi {
    codePair: {
      status(): Promise<CodePairStatus>;
      setup(): Promise<{ enrolled: true; weak: boolean } | CodePairError>;
      /** Removes the approval key and every Mac paired by code (they pair again); `controllers` is how many were removed. */
      resetApproval(): Promise<{ reset: true; controllers: number } | CodePairError>;
      offer(): Promise<{ offerId: string; code: string; expiresAt: number } | CodePairError>;
      allow(p: { offerId: string }): Promise<{ accepted: true; fingerprint: string } | CodePairError>;
      deny(p: { offerId: string }): Promise<{ accepted: false } | CodePairError>;
      cancel(p: { offerId: string }): Promise<{ cancelled: boolean } | CodePairError>;
      onEvent(cb: (e: CodePairEvent) => void): () => void;
    };
  }
}
