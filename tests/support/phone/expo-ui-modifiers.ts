// @expo/ui modifiers in the test DOM: each is kept as data for the stand-in views to read.
export const accessibilityLabel = (label: string) => ({ type: 'accessibilityLabel', label });
export const disabled = (disabled = true) => ({ type: 'disabled', disabled });
