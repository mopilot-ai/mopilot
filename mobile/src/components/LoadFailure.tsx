// What a chat page says when its read failed, under the Mac's reason: that it could not be loaded and a Retry, unless the chat does not exist (then there is nothing to retry).
import { Text } from 'react-native';
import { Button, useStyles } from './ui';

export function LoadFailure({
  empty,
  failed,
  lost,
  gone,
  retry,
}: {
  /** The page has no rows yet and the computer is there: it must not stay blank. */
  empty: boolean;
  /** The read failed (an error or the follow's own failure). */
  failed: boolean;
  /** The follow itself failed, so reading again is a Retry. */
  lost: boolean;
  /** The Mac said the chat does not exist. */
  gone: boolean;
  retry: () => void;
}) {
  const styles = useStyles();
  return (
    <>
      {empty && failed && !gone && (
        <Text accessibilityLiveRegion="polite" style={styles.muted}>
          Could not load this chat.
        </Text>
      )}
      {lost && !gone && <Button secondary title="Retry" onPress={retry} />}
    </>
  );
}
