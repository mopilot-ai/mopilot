// Counts the UI thread's frames while the performance log is on: every frame's length is bucketed on that thread (over 25 and over 50 ms) and the sums reach the log once a second. Mounted only while the log is on, so it costs nothing otherwise.
import { type ReactNode, useEffect, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { useFrameCallback, useSharedValue } from 'react-native-reanimated';
import { perf, SLOW, STALL, usePerfRender } from '../perfLog';

function Probe() {
  const total = useSharedValue(0);
  const over25 = useSharedValue(0);
  const over50 = useSharedValue(0);
  useFrameCallback((frame) => {
    'worklet';
    const ms = frame.timeSincePreviousFrame;
    if (ms === null) return;
    total.value += 1;
    if (ms > SLOW) over25.value += 1;
    if (ms > STALL) over50.value += 1;
  });
  useEffect(() => {
    const id = setInterval(() => {
      perf.uiFrames({ total: total.value, over25: over25.value, over50: over50.value });
      total.value = 0;
      over25.value = 0;
      over50.value = 0;
    }, 1000);
    return () => clearInterval(id);
  }, [total, over25, over50]);
  return null;
}

/** A thin strip at the right edge, centred (clear of the back gesture and the composer), present only while the log is on: a tap writes the numbers so far to the console and starts the next phase, so a run can be read per phase from a chat without leaving it. */
function PhaseMark() {
  return (
    <Tap
      feel="none"
      accessibilityRole="button"
      accessibilityLabel="Next performance phase"
      onPress={() => perf.phase()}
      style={{ position: 'absolute', right: 0, top: '45%', width: 14, minHeight: 44, opacity: 0.3, backgroundColor: '#888', zIndex: 9999 }}
    />
  );
}

/** The probe and the phase mark, present while the log is on. */
export function PerfHost() {
  const on = useSyncExternalStore(perf.subscribe, () => perf.enabled);
  return on ? (
    <>
      <Probe />
      <PhaseMark />
    </>
  ) : null;
}

/** The app's frame while measuring: a finger going down starts the log's wait for the first commit (the capture only reads the touch), and the probe is present while the log is on. */
export function PerfFrame({ children }: { children: ReactNode }) {
  // the app's screens render as children of this one: its renders are the app root's
  usePerfRender('App');
  return (
    <View style={{ flex: 1 }} onTouchStartCapture={(event) => perf.touch(event.nativeEvent.timestamp)}>
      <PerfHost />
      {children}
    </View>
  );
}
