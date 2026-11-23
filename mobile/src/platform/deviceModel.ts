// The phone's model name for its pairing name ("iPhone 16 Pro"), or null on a build whose native shell has no device module yet: read through the optional lookup, because importing expo-device on such a shell throws while it loads.
export function deviceModel(
  load: () => { modelName?: string | null } | null = () => require('expo').requireOptionalNativeModule('ExpoDevice'),
): string | null {
  try {
    return load()?.modelName ?? null;
  } catch {
    return null;
  }
}
