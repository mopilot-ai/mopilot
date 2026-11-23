// A machine's one-line reason in the user's words: the registry words a failed heartbeat or a missing agent as a developer sentence, so every row (the chip menu, Settings → My machines, Switch host) reads a short phrase and keeps the original as its tooltip.
import { machineReason } from '../../shared/host/machineLine.mjs';

/** An agent as the machine's row lists it: the id the registry's sentence names and the label to show. */
export type NoteAgent = { id: string; label: string };

/** The short phrase for a registry reason (shared with the phone: shared/host/machineLine.mjs). */
export { machineReason };

/** The registry's own words as a tooltip, only where the row shows a different phrase. */
export const machineReasonTitle = (note: string, agents: readonly NoteAgent[] = []): string | undefined =>
  machineReason(note, agents) === note ? undefined : note;
