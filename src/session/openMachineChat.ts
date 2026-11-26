// Opening a chat only a machine's Host lists: main takes it in (this Mac records that it runs there and follows it), then the chat opens in the one chat view every chat uses, once its record has reached this window.
import { native } from '../lib/native';
import { reloadHostChats } from '../lib/hostChats';
import { get, set, toast, useStore } from '../store/core';
import { errorText, ignoring } from '../lib/ignored';
import { openChat, type OpenChatWhere } from './openChat';

/** How long the window waits for the chat's record after main took it in. */
export const RECORD_WAIT_MS = 4000;

/** Resolves once `chatId` is a chat of this window's store, or after `ms`. */
function recordOf(chatId: string, ms: number): Promise<boolean> {
  if (get().threads[chatId]) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      off();
      resolve(ok);
    };
    const off = useStore.subscribe((s) => s.threads[chatId] && done(true));
    const timer = setTimeout(() => done(false), ms);
  });
}

/** Takes the machine's chat in and opens it where the click asked; a failure says so and opens nothing. */
export async function openMachineChat(
  machineId: string,
  chatId: string,
  where: OpenChatWhere,
  { title = '', machineName = 'The machine', wait = RECORD_WAIT_MS }: { title?: string; machineName?: string; wait?: number } = {},
) {
  try {
    const { chatId: id } = await native.hostChats.open(machineId, chatId);
    // the chat's machine is known to every row before its record opens
    await reloadHostChats();
    if (!(await recordOf(id, wait))) {
      // taken in and never arrived: it is not kept bound to the machine, and the person is told what happened
      await native.hostChats.release(machineId, chatId).catch(ignoring('release a chat that did not arrive'));
      return void toast(`${machineName} did not send that chat in time. Open it again to try once more.`, 'error');
    }
    // the record main announced has no name yet: the machine's own title stands until the chat's transcript names it
    const record = get().threads[id] as { name?: string } | undefined;
    if (title && record && !record.name) set((s) => ({ threads: { ...s.threads, [id]: { ...s.threads[id], name: title } } }));
    openChat(id, where);
  } catch (error) {
    toast(`Couldn't open that chat: ${errorText(error)}`, 'error');
  }
}
