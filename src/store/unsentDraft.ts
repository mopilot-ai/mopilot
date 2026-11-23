// Whether a window holds a draft not yet sent: read apart from the store's slices, so a test's store stub keeps it.
import type { AppState } from './state';

/** A composer's draft exists nowhere else: what is typed or attached here is lost with the window. */
export const hasUnsentDraft = (s: Pick<AppState, 'drafts'>) =>
  Object.values(s.drafts).some((d) => !!d && (d.text.trim() !== '' || d.attachments.length > 0));
