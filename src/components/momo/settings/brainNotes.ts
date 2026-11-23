// What the user is told after a MoMo brain change, by how it reached the main chat (#2183): shared by Settings › MoMo › Brain and setup's Start, so both say it the same way.
import type { MomoBrainChangeView } from '../../../lib/momoBridges';

const APPLIED_NOTE: Record<MomoBrainChangeView['applied'], string | null> = {
  saved: null,
  now: null,
  nextMessage: 'MoMo switches with its next message',
  newChat: 'MoMo started a new chat on its new brain',
};

/** The words for a change and whether they are a warning (an error toast) or a plain note; null when it is simply done. */
export function brainChangeNote(r: Pick<MomoBrainChangeView, 'applied' | 'warning'>): { text: string; kind: 'error' | 'info' } | null {
  if (r.warning) return { text: r.warning, kind: 'error' };
  const text = APPLIED_NOTE[r.applied];
  return text ? { text, kind: 'info' } : null;
}
