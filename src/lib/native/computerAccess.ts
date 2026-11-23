// window.native.computerAccess's types (Computer access, #1364), merged into NativeApi; the calls are declared in electron/bridge/computerAccess.cjs.
export {};

/** What a paired device may use on this Mac. */
export interface AccessScopes {
  browser: boolean;
  chrome: boolean;
  apps: boolean;
  files: boolean;
}

/** A device paired with this Mac (its key stays in main; the fingerprint is what a person compares). */
export interface AccessDevice {
  id: string;
  name: string;
  fingerprint: string;
  scopes: AccessScopes;
  pairedAt: number;
  lastSeen: number | null;
  hostOnlyApprovals: boolean;
  expired: boolean;
  online: boolean;
}

/** A chat on a paired device using this Mac right now. */
export interface AccessActive {
  id: string;
  device: string;
  deviceName: string;
  chat: string;
  harness: string;
}

/** This Mac's side, as Settings shows it. */
export interface AccessHostState {
  /** safeStorage can keep the keys: without it access can't be turned on */
  available: boolean;
  /** why the saved settings can't be used (Reset starts over), else null */
  problem: string | null;
  enabled: boolean;
  /** MoPilot turned computer access off everywhere */
  blocked: boolean;
  lan: boolean;
  listening: { address: string; port: number } | null;
  pairing: { expiresAt: number } | null;
  request: { name: string; code: string } | null;
  devices: AccessDevice[];
  active: AccessActive[];
}

/** A computer this install paired with. */
export interface AccessComputer {
  id: string;
  name: string;
  address: string;
  port: number;
  pairedAt: number;
  connected: boolean;
}

/** One line of the access log (electron/computerAccess/accessLog.cjs): ids, names, tool and outcome, never a value. */
export interface AccessLogLine {
  t: string;
  event: 'pairing' | 'paired' | 'denied' | 'connected' | 'disconnected' | 'refused' | 'revoked' | 'call' | 'stop' | 'off';
  device?: string;
  deviceName?: string;
  chat?: string;
  harness?: string;
  tool?: string;
  policy?: string;
  argKeys?: string[];
  outcome?: string;
  code?: string;
  ms?: number;
}

declare module '../native' {
  interface NativeApi {
    computerAccess: {
      state(): Promise<{ host: AccessHostState | null; computers: AccessComputer[] }>;
      /** the person's switch, and the kill switch: off ends every remote session at once */
      setEnabled(on: boolean): Promise<void>;
      /** let computers on this network connect (off: this Mac only, 127.0.0.1) */
      setLan(on: boolean): Promise<void>;
      /** a new pairing offer to paste on the other computer; null while not listening */
      startPairing(): Promise<{ text: string; expiresAt: number } | null>;
      cancelPairing(): Promise<void>;
      /** the person's answer to a device waiting to pair */
      answerPairing(allow: boolean, scopes?: Partial<AccessScopes>): Promise<{ id: string; name: string } | null>;
      setDevice(id: string, patch: { scopes?: Partial<AccessScopes>; hostOnlyApprovals?: boolean }): Promise<boolean>;
      revoke(id: string): Promise<boolean>;
      /** stop a remote chat's session on this Mac (its device stops the chat) */
      stop(ownerId: string): Promise<boolean>;
      log(limit?: number): Promise<AccessLogLine[]>;
      reset(): Promise<void>;
      /** pair with another computer from its offer; resolves with the code to compare, the outcome comes on onPaired */
      pair(offer: string): Promise<{ code: string }>;
      forget(id: string): Promise<boolean>;
      onChanged(cb: () => void): () => void;
      onPaired(cb: (r: { ok: true; name: string } | { ok: false; error: string }) => void): () => void;
    };
  }
}
