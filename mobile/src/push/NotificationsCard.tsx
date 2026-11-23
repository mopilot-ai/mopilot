// The notification explanation card: why the phone asks, what a notification shows, and the two honest choices.
import { Text } from 'react-native';
import { NotificationPreview } from '../components/Onboarding';
import { OpenSettings } from '../components/OpenSettings';
import { Button, Card, useStyles, Heading } from '../components/ui';
import type { PushController } from './controller';
import type { PermissionStep } from './permission';

export function NotificationsCard({ push, step, busy }: { push: PushController; step: PermissionStep; busy: boolean }) {
  const styles = useStyles();
  if (step !== 'explain' && step !== 'blocked') return null;
  return (
    <Card>
      <Heading>Know when a chat needs you</Heading>
      {step === 'explain' ? (
        <>
          <Text style={styles.text}>
            Get a notification when a chat on your computer needs an approval or an answer, or when it finishes. Notifications show only a
            short fixed title, never what a chat wrote.
          </Text>
          <NotificationPreview />
          <Button title={busy ? 'Asking…' : 'Turn on notifications'} disabled={busy} onPress={() => void push.accept()} />
          <Button secondary title="Not now" disabled={busy} onPress={() => void push.later()} />
        </>
      ) : (
        <>
          <Text style={styles.muted}>
            Notifications are off. Turn them on for MoPilot in your phone's settings to be told when a chat needs you.
          </Text>
          <OpenSettings />
        </>
      )}
    </Card>
  );
}
