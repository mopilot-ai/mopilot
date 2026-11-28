export declare const MOMO_TAG: 'momo-context';
export declare const MOMO_CONTEXT_KEY: 'mopilot.momo-context';
export declare const MOMO_PREAMBLE: string;
export declare const USER_NOTE: string;
export declare const FACTS_NOTE: string;
export declare const HISTORY_NOTE: string;
export declare function identityNote(name: string): string;
export declare function isMomoBlock(text: unknown): boolean;
export declare const NUDGES_NOTE: string;
export declare const OWNER_RULES_NOTE: string;
export declare const OWNER_RULES_MAX: number;
export declare const OWNER_RULE_CHARS: number;
export declare const OWNER_RULE_KINDS: string[];
export declare function abilitiesNote(a: { sources?: unknown; readsMail?: unknown } | null | undefined): string;
export declare function CHANNEL_NOTE(name: string): string;
export declare function momoBlock(
  summary:
    | {
        name?: unknown;
        persona?: unknown;
        aboutYou?: unknown;
        facts?: unknown;
        history?: unknown;
        nudges?: unknown;
        ownerRules?: unknown;
        abilities?: { sources?: unknown; readsMail?: unknown } | null;
        channel?: { name?: unknown; instructions?: unknown } | null;
      }
    | null
    | undefined,
): string | null;
export declare function withoutMomoBlock(text: unknown): string;
export declare function withMomoContext(prompt: string, block: string | null | undefined): string;
