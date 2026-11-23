// The production Chats home layout control as the entry test sees it: one per mounted App, read once by the home.
export function createProductionHomeLayout() {
  const control = { reads: 0, read: async () => (control.reads++, 'project' as const), set: async () => undefined };
  return control;
}
