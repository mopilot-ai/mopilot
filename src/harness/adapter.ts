// The harness contract. Adapter instances live in main; the renderer only reads resolved caps.
// Two first-tier harnesses (codex, claude) and any number of basic ones over ACP (acp:<id>).
import type { HarnessId } from './types';
import type { HarnessKind, WhyLayer } from '../../shared/model/harness';
export type {
  AccountCaps,
  ApprovalKind,
  Binding,
  CapState,
  CommandInfo,
  ConfigOption,
  FeatureFlags,
  GoalSnapshot,
  HarnessAdapter,
  HarnessKind,
  ModeOption,
  ModelInfo,
  NativeRef,
  Negotiated,
  PolyfillEngine,
  ProviderProfile,
  SageInputPart,
  SageItem,
  SageToolset,
  Semantic,
  SessionState,
  StaticInfo,
  TaskSnapshot,
  Why,
  WhyFix,
  WhyLayer,
} from '../../shared/model/harness';

export type { HarnessId };
export const isFirstTier = (k: HarnessKind): k is HarnessId => k === 'codex' || k === 'claude';

export { SEMANTICS } from '../../shared/caps.mjs';

/** Layers in resolution order. 'version' is a failed runtime probe and only greys out that one capability. */
export const WHY_LAYERS = ['harness', 'version', 'provider', 'account', 'model', 'flag', 'session'] as const satisfies readonly WhyLayer[];
