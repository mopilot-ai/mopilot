// The runtime a Thread reads and writes a chat through (X4): the one it is given, or, for a machine's chat while the Mac is away (or for a chat this phone started on the machine itself) and the phone reaches the machine, the machine's own (hostChat.ts).
import { useEffect, useMemo, useReducer } from 'react';
import type { MobileRuntime } from '../contracts';
import { facade, goesDirect, heldByMachine } from './hostChat';

/** `offline` is the Mac's away-ness the chat still reads as when no machine path takes over. */
export function useHostRuntime(
  base: MobileRuntime,
  hostId: string | undefined,
  macAway: boolean,
  chatId?: string,
): { runtime: MobileRuntime; offline: boolean } {
  const direct = base.direct;
  // the phone's own outbox changes without the Mac's runtime saying so: a message waiting for the machine, or refused by it, must show
  const [, again] = useReducer((n: number) => n + 1, 0);
  useEffect(() => direct?.subscribe(again), [direct]);
  // A chat is routed by who holds it, not by whether the Mac happens to be reachable: a chat only the machine knows (one this phone started
  // there, or one with a message of this phone's still waiting for or refused by the machine) always goes to the machine; one the Mac also
  // knows may go either way, and goes to the machine while the Mac is away.
  const onlyMachine = heldByMachine(direct?.chat, hostId, chatId);
  const on = goesDirect({
    on: direct?.chat.enabled() === true,
    kit: direct?.chat,
    machineId: hostId,
    phones: direct?.phones,
    macAway: macAway || onlyMachine,
  });
  const runtime = useMemo(
    () =>
      on && direct && hostId
        ? facade(
            base,
            direct.chat,
            hostId,
            direct.phones.records().find((r) => r.machineId === hostId)?.name ?? 'the machine',
            direct.phones,
          )
        : base,
    [on, base, direct, hostId],
  );
  return { runtime, offline: macAway && !on };
}
