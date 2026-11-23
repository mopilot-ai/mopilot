// Test-only SF Symbols for the web preview: an empty box of the symbol's size.
import React from 'react';
export type SFSymbol = string;
export const SymbolView = ({ size = 16 }: { size?: number }) => <span style={{ display: 'inline-block', width: size, height: size }} />;
