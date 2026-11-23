// Production entry creates the real runtime; preview and tests inject their own into MobileApp.
import { lazy, Suspense, useEffect, useState } from 'react';
import Constants from 'expo-constants';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { createMobileRuntime } from './src/runtime';
import { MobileApp } from './src/MobileApp';
import { createProductionPush } from './src/push/production';
import { createProductionLiveActivity } from './src/push/liveActivityProduction';
import { createProductionAppearance } from './src/platform/appearance';
import { createProductionHomeLayout } from './src/platform/homeLayout';
import { createProductionHaptics } from './src/platform/haptics';
import { phoneUiControl, phoneUiFlag } from './src/platform/phoneUi';
import { openChatCache, openListCache, openPictureCache } from './src/platform/chatStore';
import { openTraceStore } from './src/platform/traceStore';
import { attachTraceStore } from './src/launchTrace';
import { openMomoCache } from './src/platform/momoStore';
import { startDevPairLink } from './src/platform/devPairLink';
import { nativeMedia } from './src/platform/media';
import { displayVersion } from './src/appVersion';
import { phoneName } from './src/phoneName';
import { deviceModel } from './src/platform/deviceModel';
import { endpoints } from './src/platform/endpoints';
import { hostChatFlag } from './src/platform/hostChatFlag';
import { devEndpointsOf } from './src/endpoints';
import { setInPlaceSelection } from './src/platform/inPlaceSelection';
import { nativeGate } from './src/presentation/nativeGate';
import './src/platform/selectableTextNative';
import { bindSupportFlag } from './src/ui/support/supportFlag';
bindSupportFlag(() => phoneUiFlag.get() === 'v2');

/** A developer build made with MOPILOT_SELECTABLE_PROBE=1 opens the #4837 probe instead of the app; the probe's code is not loaded otherwise. */
const SelectableTextProbe = lazy(() => import('./src/screens/SelectableTextProbe').then((m) => ({ default: m.SelectableTextProbe })));

export default function App() {
  return (Constants.expoConfig?.extra as { selectableProbe?: boolean } | undefined)?.selectableProbe ? (
    <Suspense fallback={null}>
      <SelectableTextProbe />
    </Suspense>
  ) : (
    <MainApp />
  );
}

function MainApp() {
  setInPlaceSelection((Constants.expoConfig?.extra as { inPlaceSelection?: boolean } | undefined)?.inPlaceSelection === true);
  // native text views are mounted when a chat is still and the run is near the screen, not all at once (#5369)
  nativeGate.configure(true);
  const [runtime] = useState(() => createMobileRuntime(endpoints.relayUrl, endpoints.dev, hostChatFlag));
  const [momoCache] = useState(() => openMomoCache().catch(() => null));
  const [rowCache] = useState(() => openChatCache().catch(() => null));
  const [listCache] = useState(() => openListCache().catch(() => null));
  const [pictureCache] = useState(() => openPictureCache().catch(() => null));
  // the launch and chat-open timings Settings › About lists; a store that will not open leaves them unsaved
  useState(() => void openTraceStore().then(attachTraceStore, () => undefined));
  // runs for the app's whole life, not only while Settings is open: the switch, the activity and its relay token
  const [liveActivity] = useState(() => createProductionLiveActivity(runtime));
  // signing out ends the activity and drops its relay token while the session still authenticates
  const [push] = useState(() => createProductionPush(runtime, { beforeSignOut: () => liveActivity.forget(), liveActivity }));
  useEffect(() => {
    void liveActivity.start();
    return () => liveActivity.stop();
  }, [liveActivity]);
  // a build with a dev host pairs from `mopilot://pair?code=...` (mobile/src/devPairLink.ts); any other build ignores such links
  useEffect(() => startDevPairLink(runtime, phoneName(Constants, deviceModel()), endpoints.dev), [runtime]);
  // the saved System/Light/Dark choice is applied here, as soon as it is read
  const [appearance] = useState(() => {
    const control = createProductionAppearance();
    control.read().catch(() => undefined);
    return control;
  });
  // the saved Phone UI choice is read before anything asks which UI to draw (the value is then fixed for this launch)
  // the first screen to ask which UI is drawn fixes it for the launch, so nothing is drawn until the saved choice has been read (or failed to be)
  const [uiRead, setUiRead] = useState(false);
  useState(() => void phoneUiFlag.load().finally(() => setUiRead(true)));
  // the saved By project / By state choice of the Chats home is read by the home itself
  const [homeLayout] = useState(createProductionHomeLayout);
  // the saved Haptic feedback choice is read once; until then haptics play
  const [haptics] = useState(() => {
    const control = createProductionHaptics();
    control.read().catch(() => undefined);
    return control;
  });
  if (!uiRead) return null;
  return (
    // gestures (drawer, sheets, image viewer) are recognised on the UI thread through this root
    <GestureHandlerRootView style={{ flex: 1 }}>
      <MobileApp
        runtime={runtime}
        media={nativeMedia}
        momo={{ cache: momoCache }}
        rows={rowCache}
        lists={listCache}
        pictures={pictureCache}
        push={push}
        appearance={appearance}
        haptics={haptics}
        phoneUi={phoneUiControl}
        homeLayout={homeLayout}
        version={displayVersion(Constants)}
        phoneName={phoneName(Constants, deviceModel())}
        devEndpoints={devEndpointsOf(endpoints)}
      />
    </GestureHandlerRootView>
  );
}
