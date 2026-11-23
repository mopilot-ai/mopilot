// Draft-local harness choices carry a revision so a completed start cannot consume a replacement draft's choice.
import type { HarnessKind } from '../harness/adapter';
import type { AppState } from './state';

type Draft = Pick<AppState, 'newChatHarnessPick' | 'newChatHarnessRevision'>;

export const replaceDraftHarness = (state: Draft, kind: HarnessKind | null): Draft => ({
  newChatHarnessPick: kind,
  newChatHarnessRevision: state.newChatHarnessRevision + 1,
});

/** Retire only the choice that this start consumed, including when a replacement chose the same harness. */
export function consumeDraftHarness(current: Draft, started: Draft): Partial<Draft> {
  return current.newChatHarnessPick === started.newChatHarnessPick && current.newChatHarnessRevision === started.newChatHarnessRevision
    ? replaceDraftHarness(current, null)
    : {};
}
