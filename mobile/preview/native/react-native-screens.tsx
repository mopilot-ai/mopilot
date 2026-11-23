// Test-only screen stack for the web preview: only the top screen is drawn, as a plain view.
import React from 'react';
import type { ReactNode } from 'react';
import { View } from 'react-native';
export const ScreenStack = ({ children, style }: { children?: ReactNode; style?: object }) => {
  const items = Array.isArray(children) ? children : [children];
  return <View style={style}>{items.at(-1)}</View>;
};
export const ScreenStackItem = ({ children, contentStyle }: { children?: ReactNode; contentStyle?: object }) => (
  <View style={contentStyle}>{children}</View>
);
