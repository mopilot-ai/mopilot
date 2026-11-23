// Test-only notifications for the web preview: permission is undetermined, no token, nothing scheduled.
const none = async () => undefined;
const off = () => ({ remove() {} });
export const AndroidImportance = { DEFAULT: 3, HIGH: 4, MAX: 5 };
export const AndroidNotificationVisibility = { PUBLIC: 1, PRIVATE: 0, SECRET: -1 };
export const addNotificationResponseReceivedListener = off;
export const addPushTokenListener = off;
export const deleteNotificationChannelAsync = none;
export const getDevicePushTokenAsync = async () => {
  throw new Error('No push token in the web preview');
};
export const getLastNotificationResponseAsync = async () => null;
export const getPermissionsAsync = async () => ({ status: 'undetermined', granted: false, canAskAgain: true });
export const registerTaskAsync = none;
export const requestPermissionsAsync = async () => ({ status: 'denied', granted: false, canAskAgain: false });
export const scheduleNotificationAsync = async () => 'preview';
export const setNotificationCategoryAsync = none;
export const setNotificationChannelAsync = none;
export const setNotificationHandler = () => undefined;
