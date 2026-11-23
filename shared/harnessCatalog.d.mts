// Types for the static native ACP catalog; runtime capability claims remain negotiated per session.
import type { HarnessInstallInfo } from './harnessInstall.mjs';

export interface NativeAcpDescriptor {
  id: string;
  label: string;
  vendor: string;
  bins: string[];
  docsUrl: string;
  install: HarnessInstallInfo;
  enabled: boolean;
  developer?: boolean;
  runtimeQuirks?: boolean;
  order?: number;
  instructionsFiles?: string[];
  skillRoots?: string[];
  dataNotes?: string[];
  tested?: string[];
  registry?: import('./acpRegistry.mjs').RegistryAgent;
  resumePrefix?: string;
  privacyGateCommand?: string;
  contract?: { npm: string; bin: string };
  acp: {
    args?: string[];
    env?: Record<string, string>;
    privacyDefaults: string[];
    admission: { handshakeTimeoutMs: number; requireResume?: boolean; blockedVersions?: string[] };
    [key: string]: unknown;
  };
}

export declare const ACP_CATALOG: Record<string, NativeAcpDescriptor>;
export declare const ACP_IDS: string[];
export declare const ACP_PUBLIC_IDS: string[];
export declare const ACP_SPIKE_IDS: string[];
export declare function registerRegistryAgents(agents: import('./acpRegistry.mjs').RegistryAgent[]): NativeAcpDescriptor[];
export declare function catalogResume(id: string, sessionId: string): string | null;
export declare function catalogQuirks(id: string): ({ label: string; bins: string[] } & NativeAcpDescriptor['acp']) | null;
