// The way forward from a refused permission: the app's page in the phone's Settings, where the person can allow it.
import { Linking } from 'react-native';
import { Button } from './ui';

export function OpenSettings() {
  return (
    <Button
      secondary
      title="Open Settings"
      onPress={() => {
        void Linking.openSettings().catch(() => undefined);
      }}
    />
  );
}
