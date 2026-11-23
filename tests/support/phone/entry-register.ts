// Isolate production bootstrap dependencies while exercising its actual entry points.
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const react = pathToFileURL(require.resolve('react')).href;
const jsx = pathToFileURL(require.resolve('react/jsx-runtime')).href;
const runtime = new URL('./entry-runtime.ts', import.meta.url).href;
const app = new URL('./entry-view.tsx', import.meta.url).href;
const momoStore = new URL('./entry-momo.ts', import.meta.url).href;
const chatStore = new URL('./entry-chat-store.ts', import.meta.url).href;
const traceStore = new URL('./entry-trace-store.ts', import.meta.url).href;
const probe = new URL('./entry-probe.tsx', import.meta.url).href;
const expoView = new URL('./entry-expo-view.ts', import.meta.url).href;
const expo = new URL('./entry-expo.ts', import.meta.url).href;
const push = new URL('./entry-push.ts', import.meta.url).href;
const liveActivity = new URL('./entry-live-activity.ts', import.meta.url).href;
const appearance = new URL('./entry-appearance.ts', import.meta.url).href;
const haptics = new URL('./entry-haptics.ts', import.meta.url).href;
const homeLayout = new URL('./entry-home-layout.ts', import.meta.url).href;
const phoneUi = new URL('./entry-phone-ui.ts', import.meta.url).href;
const media = new URL('./entry-media.ts', import.meta.url).href;
const constants = new URL('./entry-constants.ts', import.meta.url).href;
const endpoints = new URL('./entry-endpoints.ts', import.meta.url).href;
const devPairLink = new URL('./entry-dev-pair-link.ts', import.meta.url).href;
const hostChat = new URL('./entry-host-chat-flag.ts', import.meta.url).href;
const gesture = new URL('./entry-gesture-handler.tsx', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/mobile/App.tsx') && specifier === 'react-native-gesture-handler')
      return { url: gesture, shortCircuit: true };
    if (context.parentURL?.includes('/mobile/') && specifier === 'react') return { url: react, shortCircuit: true };
    if (context.parentURL?.includes('/mobile/') && specifier === 'react/jsx-runtime') return { url: jsx, shortCircuit: true };
    if (context.parentURL?.endsWith('/mobile/App.tsx') && specifier === './src/runtime') return { url: runtime, shortCircuit: true };
    if (context.parentURL?.endsWith('/mobile/App.tsx') && specifier === './src/MobileApp') return { url: app, shortCircuit: true };
    if (context.parentURL?.includes('/mobile/') && specifier === './src/push/production') return { url: push, shortCircuit: true };
    if (context.parentURL?.endsWith('/mobile/App.tsx') && specifier === './src/push/liveActivityProduction')
      return { url: liveActivity, shortCircuit: true };
    if (context.parentURL?.endsWith('/mobile/App.tsx') && specifier === './src/platform/momoStore')
      return { url: momoStore, shortCircuit: true };
    if (context.parentURL?.endsWith('/mobile/App.tsx') && specifier === './src/platform/chatStore')
      return { url: chatStore, shortCircuit: true };
    if (context.parentURL?.endsWith('/mobile/App.tsx') && specifier === './src/platform/traceStore')
      return { url: traceStore, shortCircuit: true };
    if (context.parentURL?.endsWith('/mobile/App.tsx') && specifier === './src/platform/appearance')
      return { url: appearance, shortCircuit: true };
    if (context.parentURL?.endsWith('/mobile/App.tsx') && specifier === './src/platform/haptics')
      return { url: haptics, shortCircuit: true };
    if (context.parentURL?.endsWith('/mobile/App.tsx') && specifier === './src/platform/homeLayout')
      return { url: homeLayout, shortCircuit: true };
    if (context.parentURL?.endsWith('/mobile/App.tsx') && specifier === './src/platform/phoneUi')
      return { url: phoneUi, shortCircuit: true };
    if (context.parentURL?.endsWith('/mobile/App.tsx') && specifier === './src/platform/media') return { url: media, shortCircuit: true };
    if (context.parentURL?.endsWith('/mobile/App.tsx') && specifier === 'expo-constants') return { url: constants, shortCircuit: true };
    if (context.parentURL?.endsWith('/mobile/App.tsx') && specifier === './src/platform/endpoints')
      return { url: endpoints, shortCircuit: true };
    if (context.parentURL?.endsWith('/mobile/App.tsx') && specifier === './src/platform/devPairLink')
      return { url: devPairLink, shortCircuit: true };
    if (context.parentURL?.endsWith('/mobile/App.tsx') && specifier === './src/platform/hostChatFlag')
      return { url: hostChat, shortCircuit: true };
    if (context.parentURL?.endsWith('/mobile/src/platform/selectableTextNative.ts') && specifier === 'expo')
      return { url: expoView, shortCircuit: true };
    if (context.parentURL?.endsWith('/mobile/App.tsx') && specifier === './src/screens/SelectableTextProbe')
      return { url: probe, shortCircuit: true };
    if (context.parentURL?.endsWith('/mobile/index.js') && specifier === 'expo') return { url: expo, shortCircuit: true };
    return next(specifier, context);
  },
});
