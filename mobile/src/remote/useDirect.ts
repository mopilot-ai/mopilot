// The phone's own paths to its Hosts as a screen reads them (X3): the enrolled machines, cards, set-up state, and the actions on them. Nothing here exists without a runtime that has a vault open.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MobileRuntime } from '../contracts';
import { answeredState, failureState, type ShownCard } from './hostCards';
import type { DirectFacts, MachineAgent } from './machines';
import type { DirectSetup } from './reach';

/** How often a screen that shows a Host's waiting cards reads them, so a card another client answered turns to its receipt within about a second. */
export const WATCH_MS = 1000;

/** While a screen that shows a Host's cards is open, they are read every `ms`; leaving stops it. */
export function useDirectWatch(runtime: MobileRuntime | undefined, ms: number = WATCH_MS) {
  const direct = runtime?.direct ?? null;
  useEffect(() => direct?.phones.watch(ms), [direct, ms]);
}

export type DirectView = {
  facts: DirectFacts;
  enrolled: (machineId: string) => boolean;
  setup: (machineId: string) => DirectSetup;
  cards: (machineId: string) => ShownCard[];
  setUp: (machineId: string) => Promise<void>;
  /** Takes the machine off this phone: its relay credential, the Mac's side and the record. */
  remove: (machineId: string) => Promise<{ complete: boolean }>;
  /** The machines the Mac says are up now, so a Host that does not answer while the Mac reaches it is enrolled again. */
  macSays: (machineIds: string[]) => void;
  refresh: (machineId: string) => Promise<boolean>;
  answer: (machineId: string, machineName: string, cardId: string, optionId: string) => Promise<void>;
};

/** The direct paths of a runtime, re-read on every change; null while the runtime has none (no vault yet, or a runtime without them). */
export function useDirect(runtime: MobileRuntime | undefined): DirectView | null {
  const direct = runtime?.direct ?? null;
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!direct) return;
    void direct.phones.load().catch(() => undefined);
    return direct.subscribe(() => setVersion((n) => n + 1));
  }, [direct]);
  const answer = useCallback(
    (machineId: string, machineName: string, cardId: string, optionId: string) =>
      direct!.phones.answer(
        machineId,
        machineName,
        cardId,
        optionId,
        (error, name, optionId) => failureState(error, name, optionId),
        (kind) => answeredState(kind, null),
      ),
    [direct],
  );
  return useMemo(() => {
    // `version` changes with every change of the paths: the view is read again
    void version;
    if (!direct) return null;
    const { phones, cards } = direct;
    const facts: DirectFacts = {
      records: phones.records(),
      waiting: (id) => cards.waiting(String(phones.hostKeyOf(id))),
      reachable: (id) => phones.reachable(id),
      agents: (id) => phones.agents(id) as MachineAgent[] | null,
    };
    return {
      facts,
      enrolled: (id) => phones.enrolled(id),
      setup: (id) => phones.setupState(id),
      cards: (id) => cards.list(String(phones.hostKeyOf(id))),
      setUp: (id) => phones.setUp(id),
      remove: (id) => phones.forget(id),
      macSays: (ids) => phones.macSays(ids),
      refresh: (id) => phones.refresh(id),
      answer,
    };
  }, [direct, answer, version]);
}
