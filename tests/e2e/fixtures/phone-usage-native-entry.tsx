// Mounts the production phone app for isolated native usage acceptance.
import { registerRootComponent } from 'expo';
import { MobileApp } from './src/MobileApp';
import { runtime, media } from './phone-usage-native-fixture';
registerRootComponent(() => <MobileApp runtime={runtime} media={media} />);
