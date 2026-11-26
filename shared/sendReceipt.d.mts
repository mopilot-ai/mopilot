// Native delivery and retained-input receipts shared by main and renderer.
export type SendReceipt = {
  action: 'started' | 'steered' | 'queued' | 'held' | 'discarded' | 'failed' | 'dispatched';
  id: string;
  error?: string;
};
export function sendReceipt(
  result: { started?: boolean; delivery?: string; held?: boolean; discarded?: boolean; error?: string } | null | undefined,
  id: string,
  queued: boolean,
  accepted?: string,
): SendReceipt;
export function isAcceptedReceipt(receipt: unknown): receipt is SendReceipt;
export function acceptSendReceipt(receipt: unknown): string | null;
export function usedReceipt(receipt: unknown): boolean;
