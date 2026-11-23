// Resolve mobile React to the test renderer's instance and replace native-only APIs with DOM boundaries.
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const react = pathToFileURL(require.resolve('react')).href;
const jsx = pathToFileURL(require.resolve('react/jsx-runtime')).href;
const aliases: Record<string, string> = {
  'react-native': new URL('./native.tsx', import.meta.url).href,
  'expo-camera': new URL('./camera.tsx', import.meta.url).href,
  'expo-image-picker': new URL('./expo-media.ts', import.meta.url).href,
  'expo-image': new URL('./expo-image.tsx', import.meta.url).href,
  'expo-media-library/legacy': new URL('./expo-media.ts', import.meta.url).href,
  'expo-image-manipulator': new URL('./expo-media.ts', import.meta.url).href,
  'expo-document-picker': new URL('./expo-media.ts', import.meta.url).href,
  'expo-crypto': new URL('./expo-media.ts', import.meta.url).href,
  'expo-audio': new URL('./expo-media.ts', import.meta.url).href,
  'expo-file-system': new URL('./expo-media.ts', import.meta.url).href,
  'react-native-safe-area-context': new URL('./safe-area.tsx', import.meta.url).href,
  'expo-status-bar': new URL('./status.tsx', import.meta.url).href,
  'expo-haptics': new URL('./haptics.ts', import.meta.url).href,
  'expo-clipboard': new URL('./clipboard.ts', import.meta.url).href,
  'expo-symbols': new URL('./symbols.tsx', import.meta.url).href,
  'react-native-screens': new URL('./screens.tsx', import.meta.url).href,
  'react-native-gesture-handler': new URL('./gesture-handler.tsx', import.meta.url).href,
  'react-native-reanimated': new URL('./reanimated.tsx', import.meta.url).href,
  '@expo/ui/swift-ui': new URL('./expo-ui.tsx', import.meta.url).href,
  '@expo/ui/swift-ui/modifiers': new URL('./expo-ui-modifiers.ts', import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/mobile/') && specifier === 'react') return { url: react, shortCircuit: true };
    if (context.parentURL?.includes('/mobile/') && specifier === 'react/jsx-runtime') return { url: jsx, shortCircuit: true };
    if (specifier in aliases) return { url: aliases[specifier], shortCircuit: true };
    return next(specifier, context);
  },
});
