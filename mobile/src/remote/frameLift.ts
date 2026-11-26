// The numbers the app's frame and a chat share (#5686): how far the keyboard has lifted the frame, in points, as of this frame of its slide, and how much taller than one line the composer is now.
import { createContext, useContext } from 'react';
import type { SharedValue } from 'react-native-reanimated';

/** Given by the app's frame (`KeyboardLift` in ui.tsx): the padding it puts under its content and the offset a chat scrolls by change in the same flush of the UI thread, so they cannot be a frame apart. */
export const FrameLift = createContext<SharedValue<number> | null>(null);
export const useFrameLift = () => useContext(FrameLift);

/**
 * How much taller than its one-line height the growing field (the composer) is now, in points: kept by the app's frame for the chat inside it, so the room under a sent message is
 * made for the view the chat will have once the composer is back to one line (a send empties it) and the keyboard is down.
 */
export type ComposerGrowth = {
  extra: number;
  /** The Changes chip above the composer, while it shows: it goes away when a send starts the next turn, and its height goes back to the chat's view with the composer's. */
  chip?: number;
};
export const ComposerGrowthContext = createContext<ComposerGrowth | null>(null);
export const useComposerGrowth = () => useContext(ComposerGrowthContext);
