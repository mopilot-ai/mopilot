import type { HarnessId } from './model/harness';
import type {
  AccountCaps,
  Binding,
  CapState,
  FeatureFlags,
  ModelInfo,
  Negotiated,
  PolyfillEngine,
  ProviderProfile,
  SessionState,
  Why,
} from './model/harness';

export declare const SEMANTICS: readonly [
  'goal',
  'plan',
  'review',
  'multiAgent',
  'deepReasoning',
  'compact',
  'init',
  'skills',
  'memory',
  'tasks',
  'workflows',
  'shell',
  'rename',
  'fork',
  'rewind',
  'temporary',
  'archive',
  'search',
  'clear',
  'model',
  'effort',
  'speed',
  'permissions',
  'mcp',
  'status',
  'feedback',
  'logout',
  'voiceChat',
  'audioInput',
  'cloud',
  'textGen',
  'computerUse',
  'browser',
  'dictation',
  'nativeDictation',
  'plugins',
  'computerHistory',
  'design',
  'momoContext',
  'artifacts',
  'remoteControl',
  'steer',
];
type Semantic = (typeof SEMANTICS)[number];

export declare const FAST_BLOCKED_TEXT: Record<string, string>;
export declare const POLYFILLS: Partial<Record<Semantic, PolyfillEngine>>;

/** One layer's verdict: the semantics it blocks and why. Semantics it doesn't mention pass. */
export type Gate = Partial<Record<Semantic, Why>>;

export interface CapsInput {
  tier: 'first' | 'basic';
  /** the adapter's own bindings, one per semantic */
  bindings: Record<Semantic, Binding>;
  negotiated?: Negotiated | null;
  /** semantic → probes that must pass (claude.getSettings for multiAgent, …) */
  probesFor?: Partial<Record<Semantic, string[]>>;
  provider?: ProviderProfile | null;
  model?: ModelInfo | null;
  account?: AccountCaps | null;
  flags?: FeatureFlags | null;
  /** the parts of the session the session layer reads */
  session?: (Pick<SessionState, 'turn' | 'runningElsewhere'> & { artifacts?: boolean | null; artifactsStale?: boolean }) | null;
  /** a temporary (ephemeral) chat */
  temporary?: boolean;
  /** whether a polyfill's preconditions hold right now (owner stated, difference stated, user-started cost) */
  polyfillReady?: (engine: PolyfillEngine, s: Semantic) => boolean;
}

/**
 * Context entries: +, /, message ⋯, approval cards, TitleBar ⋯.
 * Global entries: hotkeys, Work in, Voice, ⇧⌘N, the limit banner.
 */
export type Entry = { scope: 'context' } | { scope: 'global'; installed: readonly HarnessId[]; capableElsewhere?: readonly HarnessId[] };

export declare function versionGate(n: Negotiated | null | undefined, probesFor?: CapsInput['probesFor']): Gate;
export declare function providerGate(p: ProviderProfile | null | undefined): Gate;
export declare function modelGate(m: ModelInfo | null | undefined): Gate;
export declare function accountGate(a: AccountCaps | null | undefined): Gate;
export declare function flagGate(flags: FeatureFlags | null | undefined): Gate;
export declare function sessionGate(s: CapsInput['session'], temporary?: boolean): Gate;
export declare function resolveCaps(i: CapsInput): Record<Semantic, Binding>;
export declare function present(b: Binding, entry: Entry): CapState;
