// Registers the native selectable text view at launch (imported once by the app's entry): a build whose native shell has no such module keeps none.
import { requireNativeView } from 'expo';
import type { ComponentType } from 'react';
import { type SelectableTextProps, setNativeSelectableText } from './selectableText';

try {
  setNativeSelectableText(requireNativeView('MoPilotSelectableText') as ComponentType<SelectableTextProps>);
} catch {
  setNativeSelectableText(null);
}
