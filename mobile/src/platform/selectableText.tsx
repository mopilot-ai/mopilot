// The native text view of a reply's prose run, which iOS selects a range of in place (#4837): where the view is held for the app to draw. It is registered at launch by selectableTextNative.ts, so a build without the native module (or a test) simply has none.
import type { ComponentType } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import type { ProseRun } from '../presentation/proseRuns';

export type SelectableTextProps = {
  /** the run's styled stretches (presentation/proseRuns.ts) */
  runs: ProseRun[];
  serif: boolean;
  /** the app's own entries in the edit menu: one marked `native` is done by the view itself (`selectAll`: Select Cell), one marked `first` goes ahead of the system's (Ask, then Copy, as in ChatGPT), one marked `near` right after Copy (Select Cell), the rest after the system's; one marked `selection` acts on the selected words (it is not offered as a VoiceOver action, which has none); one marked `off` is greyed, with `why` under it; one marked `vo` is a VoiceOver action of the text only, not a line of the menu (Select Text, which a reply's React text offered) */
  menuEntries?: {
    id: string;
    title: string;
    first?: '1';
    near?: '1';
    native?: 'selectAll';
    selection?: '1';
    off?: '1';
    vo?: '1';
    why?: string;
  }[];
  style?: StyleProp<ViewStyle>;
  onContentSize?: (e: { nativeEvent: { height: number; width: number } }) => void;
  /** a tap on a link in the run; `menu` when it was a long press (the app's own Open / Copy link menu) */
  onLinkPress?: (e: { nativeEvent: { url: string; menu?: '1' } }) => void;
  onMenuAction?: (e: { nativeEvent: { id: string; text?: string } }) => void;
  /** the system is presenting its edit menu on the view: a long press on it was answered natively */
  onMenuShown?: () => void;
  /** words in the view were selected (the long press selects a word before its menu shows, a handle drag changes the range) */
  onSelect?: () => void;
};

let view: ComponentType<SelectableTextProps> | null = null;

/** Holds the native view (null: none). */
export function setNativeSelectableText(next: ComponentType<SelectableTextProps> | null) {
  view = next;
}

/** The native view, or null where this build has none (Android, or a build from before the module). */
export const nativeSelectableText = () => view;
