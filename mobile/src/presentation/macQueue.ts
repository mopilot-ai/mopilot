// The paired Mac queue exposes only human-owned message identity and attachment counts; private paths never enter these rows.
export type Held = {
  id: string;
  text: string;
  attached: number;
  images?: number;
  /** The machine's Host did not take it: why, in its words ('' when it gave none). */
  refused?: string;
  /** Its chat moved to another machine while it waited. */
  moved?: true;
  /** What the Mac waits for before it can send it: the machine to answer, or the organization sign-in. */
  waiting?: 'host' | 'orgSignin';
};

/** The user's own queued messages in a chat's session, as the Mac lists them; another session's are not shown. */
export function heldOf(session: Record<string, unknown> | undefined): Held[] {
  const queue = session?.queue;
  if (!Array.isArray(queue)) return [];
  const out: Held[] = [];
  for (const q of queue as Record<string, unknown>[]) {
    if (q && typeof q.id === 'string' && q.id && typeof q.text === 'string' && q.mine === true)
      out.push({
        id: q.id,
        text: q.text,
        attached: typeof q.attached === 'number' ? q.attached : 0,
        ...(typeof q.images === 'number' ? { images: q.images } : {}),
        ...(typeof q.refused === 'string' ? { refused: q.refused } : {}),
        ...(q.moved === true ? { moved: true as const } : {}),
        ...(q.waiting === 'host' || q.waiting === 'orgSignin' ? { waiting: q.waiting } : {}),
      });
  }
  return out;
}
