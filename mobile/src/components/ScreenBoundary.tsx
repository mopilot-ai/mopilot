// Catches an exception thrown while a screen draws, so the phone shows what went wrong and a way back instead of a white screen.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { View } from 'react-native';
import { useHardwareBack } from '../useHardwareBack';
import { Button, ErrorLine, useStyles } from './ui';

/** What the person reads when a screen could not be drawn: short, with the reason after it. */
export const boundaryMessage = (error: unknown) =>
  `This screen could not be shown: ${error instanceof Error ? error.message : String(error)}`;

/** Android's back does what the Back button does; drawn only where there is a Back to do. */
function BackKey({ back }: { back: () => void }) {
  useHardwareBack(back);
  return null;
}

function Failed({ error, back }: { error: unknown; back?: () => void }) {
  const styles = useStyles();
  return (
    <View style={[styles.page, { padding: 16, gap: 12, justifyContent: 'center' }]}>
      <ErrorLine text={boundaryMessage(error)} />
      {back && <BackKey back={back} />}
      {back && <Button secondary title="Back" onPress={back} />}
    </View>
  );
}

/** Wrap a screen with a `key` that changes with what it shows, so the next chat is not held in the failure of the last. */
export class ScreenBoundary extends Component<
  { children: ReactNode; back?: () => void; report?: (error: unknown, info: ErrorInfo) => void },
  { error: unknown; failed: boolean }
> {
  state = { error: null as unknown, failed: false };
  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    (this.props.report ?? console.warn)('screen failed to draw', error, info.componentStack);
  }
  render() {
    return this.state.failed ? <Failed error={this.state.error} back={this.props.back} /> : this.props.children;
  }
}
