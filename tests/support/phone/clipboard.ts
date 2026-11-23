// expo-clipboard in the test DOM: what was copied is kept for a test to read, `__clipboardFails` makes the next copy throw, and the system Paste button (iOS 16+) is a "Paste" button that hands over `__clipboardText` (`__setPasteButton(false)` takes it away, as on an older iOS).
import { createElement } from 'react';

export async function setStringAsync(text: string) {
  const g = globalThis as any;
  if (g.__clipboardFails) {
    g.__clipboardFails = false;
    throw new Error('clipboard unavailable');
  }
  g.__clipboard = text;
  return true;
}

export let isPasteButtonAvailable = true;
(globalThis as any).__setPasteButton = (available: boolean) => {
  isPasteButtonAvailable = available;
};

export const ClipboardPasteButton = (props: any) => {
  (globalThis as any).__phonePasteProps = props;
  return createElement(
    'button',
    {
      onClick: () => {
        const g = globalThis as any;
        props.onPress(g.__clipboardImage ? { type: 'image', data: 'x' } : { type: 'text', text: g.__clipboardText ?? '' });
      },
    },
    'Paste',
  );
};
