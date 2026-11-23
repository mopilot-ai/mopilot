// The full capture of a screenshot or zoom step, read from the Mac when the step's picture is opened (steps.thumbnail): the model's own capture from the chat's history, never a new one.
import type { Owned } from './client';

/** The longest side asked for, in pixels: about the phone's screen width at 3x (the Mac clamps it to 1024). */
export const FULL_SIDE = 1024;
/** The largest picture kept in memory (base64 characters), well over what the Mac sends at that side. */
const MOST_DATA = 3_000_000;

const rec = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);

/**
 * The step's picture as a data URI, or null when there is none to show: the Mac sends `{}` for a step with no kept picture, an
 * older Mac has no such method, a Mac that is away does not answer, and a reply that is not a picture is not drawn. The caller
 * keeps the picture it already has then.
 */
export async function readStepPicture(request: Owned, chatId: string, callId: string): Promise<string | null> {
  try {
    const reply = rec(await request('steps.thumbnail', { chatId, callId, maxSide: FULL_SIDE }));
    const data = typeof reply?.data === 'string' ? reply.data : '';
    return /^[A-Za-z0-9+/]+={0,2}$/.test(data) && data.length <= MOST_DATA ? `data:image/jpeg;base64,${data}` : null;
  } catch {
    return null;
  }
}
