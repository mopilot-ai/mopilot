// Leaving the account on this phone: the push registration and the session end, and everything the phone kept for the account goes (rows, machines, folders, lists, MoMo's memory).
import type { MobileRuntime } from './contracts';
import { forgetRows } from './presentation/threadCache';
import { forgetMachines } from './remote/knownMachines';
import { forgetFolders } from './remote/lastFolders';
import { forgetMessageImages } from './remote/messageImage';

type Clearable = { clear: () => Promise<unknown> };

export async function leaveAccount(o: {
  push?: { signOut: () => Promise<unknown> };
  runtime: Pick<MobileRuntime, 'signOut'>;
  rowCache?: Clearable | null;
  listCache?: Clearable | null;
  pictureCache?: Clearable | null;
  momoCache?: Promise<Clearable | null> | null;
}) {
  await (o.push ? o.push.signOut() : o.runtime.signOut());
  forgetRows();
  forgetMachines();
  forgetFolders();
  forgetMessageImages();
  await o.rowCache?.clear().catch(() => undefined);
  await o.listCache?.clear().catch(() => undefined);
  await o.pictureCache?.clear().catch(() => undefined);
  await (await o.momoCache)?.clear();
}
