import type { Handoff } from './handoff.mjs';
import type { Sealer } from './seal.mjs';
import type { GoogleState } from './state.mjs';
export type Catcher = {
  redirectUri: string;
  open(url: string): Promise<void>;
  wait(): Promise<Handoff | null>;
  close(): void;
};
// biome-ignore lint/suspicious/noExplicitAny: the home's answer to each step has its own shape, which the flow reads field by field
export type GoogleHost = { call(op: string, params?: object): Promise<any> };
export type SignInResult = { ok: true; state: GoogleState } | { ok: false; code: string; message: string };
export declare function signInToGoogle(o: {
  host: GoogleHost;
  startCatcher: () => Promise<Catcher>;
  sealer: Sealer;
  purpose: 'read' | 'send';
  client: 'desktop' | 'ios';
}): Promise<SignInResult>;
export declare function disconnectGoogle(
  host: GoogleHost,
): Promise<{ ok: true; revoked: boolean; state: GoogleState } | { ok: false; code: string; message: string }>;
export declare function configureGoogle(
  host: GoogleHost,
  clients: { desktopJson: string; iosClientId?: string },
): Promise<{ ok: true; state: GoogleState } | { ok: false; code: string; message: string }>;
