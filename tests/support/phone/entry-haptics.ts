// The production Haptic feedback control as the entry test sees it: one per mounted App, read once at start.
export function createProductionHaptics() {
  const control = { reads: 0, read: async () => (control.reads++, true), set: async () => undefined };
  return control;
}
