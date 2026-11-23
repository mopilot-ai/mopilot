// Settings › Account › Delete account: what is deleted, a typed confirmation of the account's email, progress and a reason when it fails.
import { useRef, useState } from 'react';
import { Text } from 'react-native';
import { Button, Card, ErrorLine, Field, useStyles } from './ui';

/** What the person is told when deleting did not work: the account service's reason, in words. */
export function deleteErrorText(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'confirm_mismatch') return "That isn't what the account expects. Check what you typed.";
  if (code === 'relay_unavailable')
    return 'The service could not remove your computers just now. Nothing was deleted; try again in a moment.';
  if (code === 'leave_failed') return "Your account was deleted, but this phone couldn't finish signing out. Close and reopen the app.";
  return "The account couldn't be deleted. Check your connection and try again.";
}

/** A session the account service no longer accepts: the account is already gone, or this sign-in is. Either way this phone leaves. */
const sessionGone = (error: unknown) => {
  const e = error as { code?: string; message?: string } | null;
  return e?.code === 'unauthorized' || /HTTP 40[01]\b|sign in required/i.test(e?.message ?? '');
};

/**
 * Deletes the account, then leaves it on this phone. A deletion that did not happen keeps the phone signed in and says why; one the service
 * already did (the session is no longer accepted) and one that just went through both finish by leaving, and a failure to leave is its own
 * message, never reported as a failed deletion.
 */
export async function deleteThenLeave(
  confirm: string,
  steps: { deleteAccount: (confirm: string) => Promise<void>; leave: () => Promise<void> },
) {
  try {
    await steps.deleteAccount(confirm);
  } catch (error) {
    if (!sessionGone(error)) throw error;
  }
  try {
    await steps.leave();
  } catch {
    throw Object.assign(new Error('This phone could not finish signing out'), { code: 'leave_failed' });
  }
}

/** What the confirmation asks the person to type: the account's email, or the word DELETE for an account that has none on file. */
const expectedText = (email?: string) => (email ? email.toLowerCase() : 'delete');

export function DeleteAccount({
  email,
  busy,
  deleteAccount,
}: {
  email?: string;
  busy: boolean;
  deleteAccount: (confirm: string) => Promise<void>;
}) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim().toLowerCase() === expectedText(email);
  const asking = useRef(false);
  if (!open) return <Button secondary quietDanger title="Delete account…" disabled={busy} onPress={() => setOpen(true)} />;
  const confirm = async () => {
    // a second tap while the first is on its way is not a second request
    if (asking.current) return;
    asking.current = true;
    setWorking(true);
    setError(null);
    try {
      await deleteAccount(typed.trim());
    } catch (e) {
      setError(deleteErrorText(e));
      setWorking(false);
    } finally {
      asking.current = false;
    }
  };
  return (
    <Card>
      <Text accessibilityRole="header" style={styles.text}>
        Delete your account?
      </Text>
      <Text style={styles.muted}>
        This deletes your MoPilot account: its sign-in on every device, including the Mac app, the link to your computers, your notification
        settings, your credits and payment history, and what you shared with MoPilot (bug reports keep only their kind and version). Your
        chats and files stay on your computers. This can't be undone.
      </Text>
      <Field
        placeholder={email ? 'Type your email to confirm' : 'Type DELETE to confirm'}
        value={typed}
        onChangeText={setTyped}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={email ? 'email-address' : 'default'}
        autoComplete={email ? 'email' : 'off'}
        textContentType={email ? 'emailAddress' : 'none'}
        editable={!working}
      />
      <ErrorLine text={error} />
      <Button
        danger
        title={working ? 'Deleting…' : 'Delete account'}
        disabled={!matches || working || busy}
        onPress={() => void confirm()}
      />
      <Button secondary title="Cancel" disabled={working} onPress={() => (setOpen(false), setTyped(''), setError(null))} />
    </Card>
  );
}
