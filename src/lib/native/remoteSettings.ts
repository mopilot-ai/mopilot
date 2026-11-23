// The local Mobile Remote settings bridge; pairing secrets are returned only to its owning document.
export interface RemotePairing {
  state: string;
  qr: string | null;
  expiresAt: number | null;
  device: string | null;
  safetyNumber: string | null;
}
export type RemoteSettingsState =
  | { visible: false }
  | {
      visible: true;
      signedIn: boolean;
      /** Who this Mac is signed in as, so a person can use the same account on the phone. */
      account: string | null;
      enabled: boolean;
      consentWarning: boolean;
      running: boolean;
      /** Why the relay is turning this Mac away, while it is; the words for each are REFUSAL_TEXT (shared/remote/relayRefusal.mjs). */
      refusal: 'capacity' | 'account_limit' | 'disabled' | null;
      locked: boolean;
      pairing: RemotePairing | null;
      devices: {
        id: string;
        pairId: string;
        name: string;
        lastSeenAt: number | null;
        pairedAt: number;
        /** This phone is currently connected and its channel is usable. */
        online: boolean;
        /** Main decides this from phone presence and channel health, shared with the tray. */
        connection: import('../../../shared/phoneConnections.mjs').PhoneConnection;
        mirrors: boolean;
        retired: boolean;
        /** Frame counts since MoPilot started: dropped, duplicates, gaps, held, throttled, and whether the session is paused; null while the channel is down. */
        frames: { dropped: number; duplicates: number; gaps: number; held: number; throttled: number; paused: boolean } | null;
      }[];
    };
declare module '../native' {
  interface NativeApi {
    remoteSettings: {
      state(): Promise<RemoteSettingsState>;
      setEnabled(on: boolean): Promise<boolean>;
      begin(): Promise<RemotePairing>;
      cancel(): Promise<boolean>;
      answer(allow: boolean): Promise<boolean>;
      revoke(id: string, pairId: string): Promise<boolean>;
      setMirrors(id: string, pairId: string, on: boolean): Promise<boolean>;
      rename(id: string, pairId: string, name: string): Promise<boolean>;
    };
  }
}
