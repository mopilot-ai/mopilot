// Default OSS provider: diagnostics and ratings have no collector, transport, storage or startup effects.
import type { TurnState } from '../../shared/model/store';
export function shareTurn(_threadId: string, _harness: string, _model: string | null, _turn: TurnState, _usage: unknown): void {
  /* Optional service disabled. */
}
/** A finished turn as a count only, for a chat whose content is never shared (MoMo's). */
export function countTurn(_threadId: string, _status: TurnState['status'] | undefined): void {
  /* Optional service disabled. */
}
export function track(_name: string, _props?: Record<string, unknown>): void {
  /* Optional service disabled. */
}
export function sendRating(_props: Record<string, unknown>): void {
  /* Optional service disabled. */
}
export function reportError(_error: unknown, _extra?: { kind?: string; component?: string }): void {
  /* Optional service disabled. */
}
export function installErrorHandlers(): void {
  /* Optional service disabled. */
}
