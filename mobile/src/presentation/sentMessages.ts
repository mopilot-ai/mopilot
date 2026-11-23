// Pending phone messages retain their send identity and transcript anchor until the Mac supplies their user records.
export type RowLike = { role: string; text: string; key?: string; clientId?: string; images?: number; pictures?: string[] };
const imageCount = (message: { images?: number; pictures?: string[] }) => message.images ?? message.pictures?.length ?? 0;
export type Sent = {
  text: string;
  pictures?: string[];
  images?: number;
  nativeId?: string;
  base: number;
  id?: string;
  remoteId?: string;
  after?: string;
  recordAfter?: string;
  seen?: string[];
  heldBefore?: string[];
};
export type FirstMessage = Pick<Sent, 'text' | 'pictures' | 'id' | 'nativeId'> & { warning?: string };
const same = (a: string, b: string) => a.trim() === b.trim();
const sameInput = (a: { text: string; images?: number; pictures?: string[] }, b: { text: string; images?: number; pictures?: string[] }) =>
  same(a.text, b.text) && imageCount(a) === imageCount(b);
const isUser = (r: RowLike) => r.role === 'user' || r.role === 'liveUser';
/** Stable transcript keys in production; occurrence keys also support normalized rows without native ids. */
function records(rows: RowLike[]) {
  const counts = new Map<string, number>();
  return rows.flatMap((r, index) => {
    if (!isUser(r)) return [];
    const text = r.text.trim();
    const images = imageCount(r);
    const signature = JSON.stringify([text, images]);
    const occurrence = counts.get(signature) ?? 0;
    counts.set(signature, occurrence + 1);
    return [
      { text, images, clientId: r.clientId, index, key: r.key ?? JSON.stringify(images ? [text, images, occurrence] : [text, occurrence]) },
    ];
  });
}
/** One record belongs to one pending send, oldest first; earlier pages cannot satisfy a later tap. */
function matched(sent: Sent[], rows: RowLike[]) {
  const available = records(rows);
  const used = new Set<string>();
  return sent.map((s) => {
    const anchor = rows.findIndex((r) => r.key !== undefined && r.key === (s.recordAfter ?? s.after));
    const found = available.find(
      (r) =>
        r.index > anchor &&
        (s.nativeId ? r.clientId === s.nativeId : imageCount(s) === 0) &&
        sameInput(r, s) &&
        !used.has(r.key) &&
        !s.seen?.includes(r.key),
    );
    if (found) used.add(found.key);
    return found?.key;
  });
}
/** Capture the rows and remote queue already present at the tap, alongside the phone's id. */
export function withSent(
  sent: Sent[],
  rows: RowLike[],
  text: string,
  id?: string,
  heldBefore: string[] = [],
  pictures: string[] = [],
  nativeId?: string,
): Sent[] {
  // a message of files alone has no bubble of its own to wait for: the Mac records no row for it, so none is drawn
  if (!text.trim() && !pictures.length) return sent;
  return [
    ...sent,
    {
      text,
      ...(pictures.length ? { pictures: [...pictures] } : {}),
      base: Math.max(
        records(rows).filter((r) => sameInput(r, { text, pictures })).length,
        ...sent.filter((s) => sameInput(s, { text, pictures })).map((s) => s.base + 1),
      ),
      after: rows.at(-1)?.key,
      recordAfter: rows.filter(isUser).at(-1)?.key,
      seen: records(rows).map((r) => r.key),
      heldBefore,
      ...(id ? { id } : {}),
      ...(nativeId ? { nativeId } : {}),
    },
  ];
}
/** The outbox or Mac queue owns its bubble while waiting; after ack this pending copy keeps it visible. */
export function waitingForRecord(sent: Sent[], rows: RowLike[], queued: { text: string; id?: string; images?: number }[] = []): Sent[] {
  const matches = matched(sent, rows);
  const open = sent.filter((_, i) => matches[i] === undefined);
  return open.filter((s, i) => {
    if (s.id && queued.some((q) => q.id === s.id || (s.remoteId !== undefined && q.id === s.remoteId))) return false;
    const copies = queued.filter((q) => (!s.id || !q.id) && sameInput(q, s)).length;
    return open.slice(i + 1).filter((o) => sameInput(o, s)).length >= copies;
  });
}
/** Retire matched sends, recording consumed row keys in survivors so a later render cannot reuse them. */
export function settled(sent: Sent[], rows: RowLike[]): Sent[] {
  const matches = matched(sent, rows);
  const consumed = matches.filter((key): key is string => key !== undefined);
  if (!consumed.length) return sent;
  return sent.flatMap((s, i) => {
    if (matches[i] !== undefined) return [];
    const unseen = consumed.filter((key) => !s.seen?.includes(key));
    return [unseen.length ? { ...s, seen: [...(s.seen ?? []), ...unseen] } : s];
  });
}
/** Hide an acknowledged record's queue bubble even when its send ack arrives later. */
export function unrecordedQueue<T extends { id: string }>(queued: T[], sent: Sent[], rows: RowLike[]): T[] {
  const matches = matched(sent, rows);
  const recorded = new Set(sent.flatMap((s, i) => (matches[i] === undefined ? [] : [s.id, s.remoteId])));
  return queued.filter((q) => !recorded.has(q.id));
}
/** Match only remote queue entries that were absent at this send's tap; repeats never steal older entries. */
export function linkHeld(sent: Sent[], held: { id: string; text: string; images?: number }[]): Sent[] {
  const used = new Set(sent.map((s) => s.remoteId));
  let changed = false;
  const next = sent.map((s) => {
    if (s.remoteId) return s;
    const match = held.find(
      (h) =>
        !used.has(h.id) && !s.heldBefore?.includes(h.id) && (s.nativeId ? h.id === s.nativeId : imageCount(s) === 0) && sameInput(h, s),
    );
    if (!match) return s;
    used.add(match.id);
    changed = true;
    return { ...s, remoteId: match.id };
  });
  return changed ? next : sent;
}

/** A remounted Thread keeps acknowledged image sends until their exact native record arrives. */
export function initialSent(
  first: FirstMessage | undefined,
  queued: { id: string; text: string; nativeId?: string; pictures?: string[]; images?: number }[],
): Sent[] {
  const initial: Sent[] = first && (first.text.trim() || first.pictures?.length) ? [{ ...first, base: 0 }] : [];
  return [
    ...initial,
    ...queued
      .filter((item) => item.nativeId && !initial.some((send) => send.id === item.id))
      .map((item) => ({ text: item.text, id: item.id, nativeId: item.nativeId, pictures: item.pictures, images: item.images, base: 0 })),
  ];
}

/**
 * The sent list after a render: matched ids stay while the outbox or the Mac's queue still holds the send (its
 * acknowledgement may arrive later and must not draw a duplicate), and the same list comes back when nothing changed.
 */
export function reconcileSent(old: Sent[], held: { id: string; text: string }[], rows: RowLike[], queued: { id: string }[]): Sent[] {
  const bound = linkHeld(old, held);
  const left = settled(bound, rows);
  const retained = bound.filter(
    (s) =>
      !left.some((l) => l.id === s.id && l.text === s.text) && (queued.some((q) => q.id === s.id) || held.some((h) => h.id === s.remoteId)),
  );
  if (left === bound) return bound;
  const next = bound.flatMap((s) => {
    const survivor = left.find((l) => l.id === s.id && l.text === s.text);
    return survivor ? [survivor] : retained.includes(s) ? [s] : [];
  });
  return next.length === bound.length && next.every((s, i) => s === bound[i]) ? bound : next;
}
