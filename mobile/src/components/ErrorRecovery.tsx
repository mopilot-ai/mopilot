// Every failure has a way forward: Retry where it can help, and for a signed-in account Sign out as the way out; an account whose credentials are refused is offered Sign out alone.
import { Button } from './ui';

export function ErrorRecovery({
  failed,
  signedIn,
  busy,
  retry,
  signOut,
  preserveAccount = false,
}: {
  failed: boolean;
  signedIn: boolean;
  busy: boolean;
  retry?: () => void;
  signOut: () => void;
  preserveAccount?: boolean;
}) {
  if (!failed) return null;
  // refused credentials: only signing in again helps, so Retry would do nothing
  const retryable = !signedIn || preserveAccount;
  return (
    <>
      {retryable && retry && <Button title={busy ? 'Retrying…' : 'Retry'} disabled={busy} onPress={retry} />}
      {signedIn && <Button secondary quietDanger title="Sign out to sign in again" disabled={busy} onPress={signOut} />}
    </>
  );
}
