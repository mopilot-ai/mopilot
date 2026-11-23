// A bubble of the message just sent, drawn invisible while the ghost bubble rises from the composer (one bubble from the tap to the landing) and plain after it.
import { type ReactNode, useState } from 'react';
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { isRiding, useRiding } from '../sendOrigin';

export function RiseIn({
  children,
  style,
  onLayout,
  rises = true,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  onLayout?: (event: LayoutChangeEvent) => void;
  /** False for a copy of the list drawn somewhere else (the computers page's outbox), which has no ghost over it. */
  rises?: boolean;
}) {
  const riding = useRiding();
  // only a bubble drawn after the send is the one the ghost stands in for; the messages above it stay
  const [born] = useState(isRiding);
  return (
    <View style={[style, rises && riding && born ? { opacity: 0 } : null]} onLayout={onLayout}>
      {children}
    </View>
  );
}
