// Speech provider readiness and operation contracts for the main service and input controls.
export type SpeechEngine = 'local' | 'chatgpt' | 'credits';
export type SpeechReadiness = 'ready' | 'permission' | 'blocked' | 'unknown';
export interface SpeechChoice {
  id: SpeechEngine;
  label: string;
  state: SpeechReadiness;
  reason: string | null;
}
export interface SpeechOptions {
  engine: SpeechEngine | null;
  /** every service the clip may be tried on, in order (Automatic); just the pinned one otherwise */
  chain: SpeechEngine[];
  choices: SpeechChoice[];
  audioMessage: boolean;
  conversation: boolean;
}
export const SPEECH_PROVIDERS: { id: SpeechEngine; label: string; pcm?: boolean }[];
/** Whether a recording goes to `engine` as WAV. */
export function takesWav(engine: SpeechEngine | string): boolean;
export function localSpeechReadiness(status: unknown): { state: SpeechReadiness; reason: string | null };
export const DICTATION_OFF: string;
/** This Mac's first use: macOS's prompt went up, and the clip ends there rather than going to another service. */
export const SPEECH_ASKED: string;
export const SPEECH_WAIT_MS: number;
export const SPEECH_TOO_LONG: string;
/** A service's name for the user ("This Mac"). */
export function speechLabel(engine: SpeechEngine | string): string;
/** An answer no other service would change: text (even none), a clip too short, dictation switched off, or macOS asking. */
export function speechSettles(answer: { error?: string } | null | undefined): boolean;
/** Every service in a chain failed: one alone keeps its own words; several each say why. */
export function speechFailure(failed: { engine: string; error: string }[]): string;
export function noSpeechReason(preference: unknown, choices: SpeechChoice[]): string;
export function speechChain(preference: unknown, choices: SpeechChoice[], native?: unknown): SpeechEngine[];
export function speechEngine(preference: unknown, choices: SpeechChoice[], native?: unknown): SpeechEngine | null;
export function speechOperations(caps: unknown): Pick<SpeechOptions, 'audioMessage' | 'conversation'>;
