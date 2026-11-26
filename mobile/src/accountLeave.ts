// Leaving the account on this phone: the push registration and the session end, and everything the phone kept for the account goes (rows, machines, folders, start picks, lists, MoMo's memory).
import type { MobileRuntime } from './contracts';
import { forgetRows } from './presentation/threadCache';
import { forgetMachines } from './remote/knownMachines';
import { forgetFolders } from './remote/lastFolders';
import { forgetPicks } from './remote/lastPicks';
import { forgetMessageImages } from './remote/messageImage';

type Clearable = { clear: () => Promise<unknown> };

/** The rows the home the phone composes itself keeps on the device, every account's (loaded when needed, so the screens do not load the database). */
export const phoneHomeRows: Clearable = { clear: async () => (await import('./platform/momoPhoneHome')).forgetPhoneHome() };

export async function leaveAccount(o: {
  push?: { signOut: () => Promise<unknown> };
  runtime: Pick<MobileRuntime, 'signOut'>;
  rowCache?: Clearable | null;
  listCache?: Clearable | null;
  pictureCache?: Clearable | null;
  momoCache?: Promise<Clearable | null> | null;
  /** What the phone kept of MoMo's home composed on its own (every account's row). */
  phoneHome?: Clearable | null;
}) {
  await (o.push ? o.push.signOut() : o.runtime.signOut());
  forgetRows();
  forgetMachines();
  forgetFolders();
  forgetPicks();
  forgetMessageImages();
  await o.rowCache?.clear().catch(() => undefined);
  await o.listCache?.clear().catch(() => undefined);
  await o.pictureCache?.clear().catch(() => undefined);
  await (await o.momoCache)?.clear();
  await o.phoneHome?.clear();
}
