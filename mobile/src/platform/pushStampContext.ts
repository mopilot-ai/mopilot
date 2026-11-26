// What a push needs to open the lease stamp sealed in it: the signed-in account and the stamp key of every Host enrollment on this phone (derived from each enrollment's pair root, which stays in the encrypted vault and is never kept anywhere else).
import { fromBase64 } from '../../../shared/remote/envelope.mjs';
import { createPhoneVault } from '../../../shared/remote/phoneVault.mjs';
import { createStampSeal } from '../../../shared/remote/stampSeal.mjs';
import type { StampContext } from '../momoPhone/pushStamps';
import { phonePrimitives } from './crypto';
import { openVaultStorage } from './vault';

/** null when nobody is signed in or no Host is enrolled: there is nothing to open a stamp with. */
export async function momoStampContext(): Promise<StampContext | null> {
  const prim = phonePrimitives();
  const vault = createPhoneVault({ prim, ...(await openVaultStorage()) });
  const user = (await vault.getAccount())?.user?.id;
  const hosts = Object.values((await vault.getHosts()) as Record<string, { root?: unknown }>);
  const seal = createStampSeal(prim);
  const keys = hosts.flatMap((h) => (typeof h.root === 'string' ? [seal.stampKey(fromBase64(h.root))] : []));
  if (typeof user !== 'string' || !keys.length) return null;
  return { user, open: (sealed, ref) => seal.open({ sealed, ref, keys }) };
}
