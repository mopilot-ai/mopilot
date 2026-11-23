// Test-only SwiftUI modifiers for the web preview: each is an inert value.
export const accessibilityLabel = (label: string) => ({ accessibilityLabel: label });
export const disabled = (on = true) => ({ disabled: on });
