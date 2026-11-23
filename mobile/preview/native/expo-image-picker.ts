// Test-only photo picker for the web preview: the person always cancels.
const canceled = async () => ({ canceled: true, assets: null });
export const launchCameraAsync = canceled;
export const launchImageLibraryAsync = canceled;
export const requestCameraPermissionsAsync = async () => ({ granted: false });
