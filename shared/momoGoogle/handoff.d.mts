import type { Sealer } from './seal.mjs';
export type Handoff = { state: string; redirectUri: string; code?: string; error?: string };
export declare const handoffContext: (flowId: string) => string;
export declare const sealHandoff: (sealer: Sealer, flowId: string, sealTo: string, hand: Handoff) => string;
export declare function parseCallback(requestUrl: string, redirectUri: string): Handoff | null;
