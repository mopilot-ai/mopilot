// Whether a reply's prose is drawn as native text views iOS selects a range of in place (#4837): on in a build unless it says MOPILOT_INPLACE_SELECTION=0 (app.config.js writes `extra.inPlaceSelection`), and only where the native view exists.
import { nativeSelectableText } from './selectableText';

let wanted = false;

/** Called once at launch with what the build asks for. */
export function setInPlaceSelection(on: boolean) {
  wanted = on;
}

export const inPlaceSelection = (): boolean => wanted && nativeSelectableText() !== null;
