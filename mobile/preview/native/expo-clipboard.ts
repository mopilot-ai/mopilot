// Test-only clipboard for the web preview: what was copied is kept on the window for checks; the system Paste button (iOS 16+) does not exist here, so the paste field is the way.
export const setStringAsync = async (text: string) => {
  (window as any).copied = text;
  return true;
};
export const isPasteButtonAvailable = false;
export const ClipboardPasteButton = (_props: unknown) => null;
