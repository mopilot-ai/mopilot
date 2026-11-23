// Inline chat mention tokens in the renderer, re-exported from the shared parser.

/** Serialized inline chat references; the editor displays the title as one atomic token. */
export interface SessionMention {
  token: string;
  title: string;
  id: string;
  start: number;
  end: number;
}
export { sessionToken, sessionMentions } from '../../shared/sessionMentions.mjs';
