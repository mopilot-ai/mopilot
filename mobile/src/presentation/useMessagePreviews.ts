// A bounded, account/pair/chat-owned local preview bridge avoids blank image handoff when a native record replaces an optimistic send before its thumbnail loads.
import { useMemo, useRef } from 'react';
import type { Row } from './thread';
type PictureInput = { nativeId?: string; pictures?: string[] };
const MAX_PREVIEWS = 100;
export function useMessagePreviews<T extends Row>(owner: string, rows: T[], sent: PictureInput[], queued: PictureInput[]): T[] {
  const retained = useRef({ owner, pictures: new Map<string, string[]>() });
  if (retained.current.owner !== owner) retained.current = { owner, pictures: new Map() };
  const bank = retained.current.pictures;
  return useMemo(() => {
    for (const input of [...sent, ...queued]) if (input.nativeId && input.pictures?.length) bank.set(input.nativeId, input.pictures);
    while (bank.size > MAX_PREVIEWS) bank.delete(bank.keys().next().value!);
    return rows.map((row) => (row.clientId && bank.has(row.clientId) ? { ...row, pictures: bank.get(row.clientId) } : row));
  }, [bank, rows, sent, queued]);
}
