// Test-only photo library for the web preview: access is refused, so the Add to session strip shows only Camera.
export const getPermissionsAsync = async () => ({ granted: false, canAskAgain: false, accessPrivileges: 'none' });
export const requestPermissionsAsync = getPermissionsAsync;
export const getAssetsAsync = async () => ({ assets: [] });
export const getAssetInfoAsync = async (id: string) => ({ id, uri: id, localUri: null, filename: 'photo', width: 1, height: 1 });
export const presentPermissionsPickerAsync = async () => undefined;
