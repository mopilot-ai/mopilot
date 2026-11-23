// Types of shared/llmProviders.mjs, the model provider catalog, for the renderer.
export type LlmWire = 'anthropic' | 'openai-chat' | 'openai-responses' | 'gemini';
export type LlmAuthStyle = 'bearer' | 'x-api-key' | 'x-goog-api-key';

export interface LlmProvider {
  id: string;
  label: string;
  wires: readonly LlmWire[];
  /** null when the user names the endpoint (`customBase`). */
  baseUrl: string | null;
  /** The env name the provider's own tools read its key from, when it has one. */
  keyEnv: string | null;
  auth: LlmAuthStyle;
  /** The key-store slot its key is kept in (a `customBase` provider's key is kept per origin: keySlotFor). */
  keySlot: string;
  customBase: boolean;
  keyOptional: boolean;
}

export declare const WIRES: readonly LlmWire[];
export declare const AUTH_STYLES: readonly LlmAuthStyle[];
export declare const LLM_PROVIDERS: Readonly<Record<string, Readonly<LlmProvider>>>;
export declare function llmProvider(id: unknown): Readonly<LlmProvider> | null;
export declare function listLlmProviders(): Readonly<LlmProvider>[];
export declare function checkBaseUrl(value: unknown): { ok: true; url: string; origin: string } | { ok: false; error: string };
export declare function keySlotFor(provider: unknown, baseUrl?: unknown): string | null;
