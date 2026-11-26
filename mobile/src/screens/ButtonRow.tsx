// A row of answer buttons: side by side while they fit, one under the other (each as wide as the card) at the larger text sizes or when `long`, as Claude on iPhone stacks wide action rows. Nothing is squeezed into a cell it does not fit.
import type { ReactNode } from 'react';
import { useWindowDimensions, View } from 'react-native';

export function ButtonRow({ children, top = 12, long = false }: { children: ReactNode; top?: number; long?: boolean }) {
  const { fontScale } = useWindowDimensions();
  return <View style={{ flexDirection: long || fontScale > 1.3 ? 'column' : 'row', gap: 8, marginTop: top }}>{children}</View>;
}
