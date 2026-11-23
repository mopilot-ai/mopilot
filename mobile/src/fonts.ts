// The platform faces the phone draws with: monospace for diffs, counts and code; serif for assistant text and greetings, as Claude for iOS sets them.
import { Platform } from 'react-native';

export const monoFamily = () => (Platform.OS === 'ios' ? 'Menlo' : 'monospace');

/** The system serif (New York on iOS), for an assistant's reply and a greeting. */
export const serifFamily = () => (Platform.OS === 'ios' ? 'ui-serif' : 'serif');
