// Isolated browser-only preview aliases native boundaries to test doubles.
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const base = path.dirname(fileURLToPath(import.meta.url));

/** Each native module the app imports, and its double under preview/native (tests/phonePreviewAliases.invariant.test.ts keeps this complete). */
export const NATIVE_DOUBLES = {
  'expo-audio': 'expo-audio.ts',
  'expo-auth-session': 'expo-auth-session.ts',
  'expo-clipboard': 'expo-clipboard.ts',
  'expo-constants': 'expo-constants.ts',
  'expo-crypto': 'expo-crypto.ts',
  'expo-document-picker': 'expo-document-picker.ts',
  'expo-file-system': 'expo-file-system.ts',
  'expo-haptics': 'expo-haptics.ts',
  'expo-image': 'expo-image.tsx',
  'expo-image-manipulator': 'expo-image-manipulator.ts',
  'expo-image-picker': 'expo-image-picker.ts',
  'expo-media-library/legacy': 'expo-media-library.ts',
  'expo-notifications': 'expo-notifications.ts',
  'expo-secure-store': 'expo-secure-store.ts',
  'expo-sqlite': 'expo-sqlite.ts',
  'expo-symbols': 'expo-symbols.tsx',
  'expo-task-manager': 'expo-task-manager.ts',
  '@expo/ui/swift-ui': 'expo-ui.tsx',
  '@expo/ui/swift-ui/modifiers': 'expo-ui-modifiers.ts',
  'react-native-gesture-handler': 'react-native-gesture-handler.tsx',
  'react-native-libsodium': 'react-native-libsodium.ts',
  'react-native-screens': 'react-native-screens.tsx',
};
/** Doubles kept beside this file since the first preview. */
export const LOCAL_DOUBLES = {
  'expo-camera': 'camera.tsx',
  'expo-status-bar': 'status.tsx',
  'react-native-safe-area-context': 'safe-area.tsx',
};
/**
 * The app imports a few CommonJS files from the repository (Metro interops them; Vite's dev server serves source as ESM). Their one shape,
 * destructured `require`s and one `module.exports = { … }`, becomes imports and an export; anything else fails the preview loudly.
 */
export function commonJsSources() {
  return {
    name: 'preview-commonjs-sources',
    transform(code, id) {
      const file = id.split('?')[0];
      if (!file.endsWith('.cjs') || file.includes('/node_modules/')) return null;
      const out = code
        .replace(/^const (\{[^}]*\}) = require\(('[^']+')\);$/gm, 'import $1 from $2;')
        .replace(/^module\.exports = (\{[^}]*\});$/m, 'export $1;');
      if (/\brequire\(|\bmodule\.exports\b|\bexports\./.test(out)) throw new Error(`preview: cannot serve ${file} as ESM; add a double for it`);
      return { code: out, map: null };
    },
  };
}
const exact = (name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`);

export default defineConfig({
  root: path.join(base, '..'),
  plugins: [commonJsSources()],
  // React Native libraries (reanimated) read Metro's globals
  define: { __DEV__: 'true', global: 'globalThis' },
  resolve: {
    alias: [
      // the app's own `react-native` adds iOS-only APIs to react-native-web; deep imports go to react-native-web's files
      { find: /^react-native$/, replacement: path.join(base, 'react-native.mjs') },
      { find: /^react-native\//, replacement: `${path.join(base, '../node_modules/react-native-web')}/` },
      ...Object.entries(LOCAL_DOUBLES).map(([name, file]) => ({ find: exact(name), replacement: path.join(base, file) })),
      ...Object.entries(NATIVE_DOUBLES).map(([name, file]) => ({ find: exact(name), replacement: path.join(base, 'native', file) })),
    ],
  },
  server: { host: '127.0.0.1', port: 4189 },
});
