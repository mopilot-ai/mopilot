// Copies text to the system clipboard (expo-clipboard), with the selection tick Claude gives a copy; a failed copy stays quiet.
import { haptic } from '../motion';

/**
 * Puts `text` on the clipboard and ticks; resolves false when the platform refused it. The module is loaded on first
 * use, so a build whose native shell predates expo-clipboard still opens (its copy just reports false).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    const Clipboard = await import('expo-clipboard');
    await Clipboard.setStringAsync(text);
  } catch {
    return false;
  }
  haptic.select();
  return true;
}
