// expo-haptics in the test DOM: each call is recorded by name for a test to read.
const record = (name: string) => {
  ((globalThis as any).__haptics ??= []).push(name);
  return Promise.resolve();
};
export const ImpactFeedbackStyle = { Light: 'light', Medium: 'medium', Heavy: 'heavy' } as const;
export const NotificationFeedbackType = { Success: 'success', Warning: 'warning', Error: 'error' } as const;
export const impactAsync = (style: string) => record(`impact:${style}`);
export const notificationAsync = (type: string) => record(`notification:${type}`);
export const selectionAsync = () => record('selection');
