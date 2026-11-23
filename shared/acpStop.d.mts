/** ACP stop reasons → the turn status the thread shows. */
/** Whether a failed prompt's error text says the harness hit its usage limit. */
export declare function isLimitError(text: unknown): boolean;
/** A turn's error as text: a Host's `{ message }` and an older record's both read as the message. */
export declare function stopErrorText(error: unknown): string | null;
/** An ACP prompt's end as the chat shows it: its status, its error, and a note for a cut-off reply or a usage limit. */
/** What to do about a provider that keeps failing, said after its error wherever the chat shows one. */
export declare const PROVIDER_NEXT_STEP: string;
/** A harness retrying its failing provider in silence, as the willRetry `error` notification the retry banner shows. */
export declare function providerRetryError(
  threadId: string,
  turnId: string,
  label: string,
  error: string,
): { threadId: string; turnId: string; willRetry: true; error: { message: string } };
export declare function acpStop(
  stopReason: string | null | undefined,
  error: string | null | undefined,
  providerError?: string | null,
): {
  status: 'completed' | 'interrupted' | 'failed';
  error: string | null;
  note: { kind: 'cutOff' | 'limit' | 'provider' | 'refusal'; text: string } | null;
};
