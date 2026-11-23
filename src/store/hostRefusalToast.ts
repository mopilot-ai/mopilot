// The toast for a refusal a machine's Host gave: its sentence, and, when the sentence asks for the Host to be updated ("... is too old for this. Update it."), the machine row's own Update pressed in place, so a failure never ends on words alone.
import { toast } from './core';
import { deletionVisibility } from './deletionVisibility';
import { hostOfChatNow } from '../lib/hostChats';
import type { ChatDeletionReceipt } from '../lib/chatDeletion';
import { native } from '../lib/native';
import { readMachineRow } from '../lib/hostMachines';
import { asksHostUpdate, hostUpdateLine } from '../lib/machineStatus';
import { userError } from '../../shared/userError.mjs';

/**
 * @param text what the machine said, with its name as the machine's row writes it
 * @param hostId the machine; without one (or when its row offers no update: a newer Host, a machine added by command, an update under way) the toast carries the sentence alone
 */
export async function toastHostRefusal(text: string, hostId: string | undefined): Promise<void> {
  const row = hostId && asksHostUpdate(text) ? await readMachineRow(hostId, "read the machine's row for its Update") : undefined;
  const update = row ? hostUpdateLine(row)?.update : undefined;
  toast(
    text,
    'error',
    update && hostId
      ? { action: { label: update.label, run: () => void native.host.update(hostId).catch((e: unknown) => toast(userError(e), 'error')) } }
      : {},
  );
}

/** A chat deleted here whose machine has not deleted it yet: the machine by name, and for a Host too old to take the deletion its Update (it waits for that, not for the machine to come back). */
export async function toastPendingDeletion(hostId: string | undefined, outdated: boolean): Promise<void> {
  const name = (hostId && (await readMachineRow(hostId, "read the machine's name for a pending deletion"))?.name) || 'The machine';
  if (outdated) return toastHostRefusal(`Deleted here. ${name} is too old to delete it there. Update it.`, hostId);
  toast(`Deleted here. ${name} deletes it when it is back.`);
}

/**
 * Taken before a chat's deletion asks, the machine and whether this window already knew the deletion: the returned function, given the receipt once the chat has left, says what is still to happen on the machine, once.
 * @param chatId the chat being deleted
 */
export function deletionNote(chatId: string): (receipt: ChatDeletionReceipt) => Promise<void> {
  // read now: the receipt takes the chat out of the lists its machine is found by, and a deletion asked again tells nothing new
  const machine = hostOfChatNow(chatId) || undefined;
  const first = !deletionVisibility.has(chatId);
  return async (receipt) => {
    if (first && receipt.remoteDeletionPending) await toastPendingDeletion(machine, receipt.remoteDeletionOutdated === true);
  };
}
