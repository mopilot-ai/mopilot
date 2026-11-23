// Expo entry point for the Mobile Remote app.
import { registerRootComponent } from 'expo';
import App from './App';
import { installDataMessageTask } from './src/push/production';
// A data message may start the process before React renders, so its task is defined at module load.
installDataMessageTask();
registerRootComponent(App);
