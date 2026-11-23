// Mounts the production phone app for isolated native composer acceptance.
import { registerRootComponent } from 'expo';
import { MobileApp } from './src/MobileApp';
import { runtime, media } from './phone-composer-native-fixture';
registerRootComponent(() => <MobileApp runtime={runtime} media={media} />);
