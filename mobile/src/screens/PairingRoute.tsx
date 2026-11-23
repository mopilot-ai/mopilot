// The pairing sheet as the app opens it: the signed-in account's name and id for the account hint, and the way out of that account when a computer uses another.
import type { MobileRuntime } from '../contracts';
import { Pairing } from './Pairing';

export function PairingRoute({
  runtime,
  user,
  name,
  host,
  setOpen,
  signOut,
}: {
  runtime: MobileRuntime;
  user: { id: string; email?: string } | null | undefined;
  /** The phone's own name, which the pairing starts with. */
  name: string | undefined;
  host: boolean;
  /** Opens or closes the sheet. */
  setOpen: (open: boolean) => void;
  signOut: () => void;
}) {
  return (
    <Pairing
      runtime={runtime}
      back={() => setOpen(false)}
      defaultName={name}
      account={user?.email}
      userId={user?.id}
      // the sheet closes with the account: nothing of it is left under the sign-in
      signOut={() => {
        setOpen(false);
        signOut();
      }}
      host={host}
    />
  );
}
