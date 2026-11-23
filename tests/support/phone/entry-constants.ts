// A stand-in for expo-constants in the production entry test: the build's Expo config with a version (and the extras a test sets), and the system's device name.
export default {
  get expoConfig() {
    return { version: '4.5.6', extra: (globalThis as any).__phoneExtra };
  },
  deviceName: 'iPhone',
  platform: { ios: {} },
};
