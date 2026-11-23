// window.native.routing's types (routed chats' providers, model configs and keys, electron/routing), merged into NativeApi; the calls are declared in electron/bridge/routing.cjs.
import type { LlmProvider } from '../../../shared/llmProviders.mjs';

export type { LlmProvider, LlmWire, LlmAuthStyle } from '../../../shared/llmProviders.mjs';

/** A catalog provider and whether a key is kept for it; null for a server the user names, whose key is kept per URL. */
export type RoutingProvider = LlmProvider & { hasKey: boolean | null };

export type ClaudeTier = 'opus' | 'sonnet' | 'haiku';

/** A named model config (electron/routing/configs.cjs): it decides the model, whatever model a request names. */
export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  /** Only for a server the user names (an OpenAI-compatible one). */
  baseUrl?: string;
  model: string;
  /** The model a request for a Claude model family gets (Claude Code's haiku helper), when it differs from `model`. */
  tierModels: Partial<Record<ClaudeTier, string>>;
  /** Tried in order when the provider fails. */
  fallbacks: { provider: string; model: string }[];
}

/** A config to save: without an id it is added with a new one. */
export type ModelConfigInput = Omit<ModelConfig, 'id' | 'tierModels' | 'fallbacks'> &
  Partial<Pick<ModelConfig, 'id' | 'tierModels' | 'fallbacks'>>;

export interface ModelConfigList {
  configs: ModelConfig[];
  /** Entries on disk this version does not take (kept as they are). */
  invalid: number;
  /** 'unreadable': the file can't be read; `configs` are the ones last read, and changes are refused. */
  state: 'ok' | 'unreadable';
}

declare module '../native' {
  interface NativeApi {
    routing: {
      /** The provider catalog, with whether each has a key; `keys` 'unreadable' when the key file can't be read. */
      providers(): Promise<{ providers: RoutingProvider[]; keys: 'ok' | 'unreadable' }>;
      configs(): Promise<ModelConfigList>;
      /** The saved config; throws {message, code} with code 'invalid', 'unreadable' or 'write_failed'. */
      saveConfig(config: ModelConfigInput): Promise<ModelConfig>;
      /** False when no config had that id. */
      removeConfig(id: string): Promise<boolean>;
      /** Whether a key is kept for the provider (for a server the user names, for its URL). */
      hasKey(provider: string, baseUrl?: string): Promise<boolean>;
      /** Keeps the key encrypted; its last four characters. */
      setKey(provider: string, key: string, baseUrl?: string): Promise<string>;
      /** False when no key was kept. */
      clearKey(provider: string, baseUrl?: string): Promise<boolean>;
      /** A config or key changed, in any window. */
      onChanged(cb: () => void): () => void;
    };
  }
}
