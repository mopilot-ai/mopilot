// Whether the person reads at a large text size (iOS Larger Text, past the standard range): rows give their words room to wrap instead of cutting them to one line.
import { useWindowDimensions } from 'react-native';

/** Above the largest of the standard sizes (about 1.3 on iOS); the accessibility sizes start higher. */
export const LARGE_TEXT = 1.35;

export const useLargeText = () => useWindowDimensions().fontScale >= LARGE_TEXT;
