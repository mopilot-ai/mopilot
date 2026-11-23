// react-native for the test-only web preview: react-native-web, plus the iOS-only APIs the app names (each guarded by Platform.OS there).
export * from 'react-native-web';
export const ActionSheetIOS = {
  showActionSheetWithOptions: () => undefined,
};
