// The production appearance control as the entry test sees it: one per mounted App, applied once at start.
export function createProductionAppearance() {
  const control = { reads: 0, read: async () => (control.reads++, 'system' as const), set: async () => undefined };
  return control;
}
