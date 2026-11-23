// Displays the injected runtime identity in the production entry test.
export function MobileApp({ runtime, media, momo, version, phoneName, devEndpoints, appearance, haptics, homeLayout, phoneUi }: any) {
  // what the first screen to ask is told: the launch's value is fixed by it
  (globalThis as any).__phoneUiAtRender = phoneUi.get();
  (globalThis as any).__momoProp = momo;
  (globalThis as any).__phoneNameProp = phoneName;
  (globalThis as any).__versionProp = version;
  (globalThis as any).__appearanceProp = appearance;
  (globalThis as any).__hapticsProp = haptics;
  (globalThis as any).__homeLayoutProp = homeLayout;
  (globalThis as any).__devEndpointsProp = devEndpoints;
  return (
    <span>
      Runtime {runtime.id}
      {media?.marker === 'native-media' ? '' : ' no media'}
    </span>
  );
}
