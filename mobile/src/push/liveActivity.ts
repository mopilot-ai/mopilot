// Whether this build has the Live Activity: the Notifications page draws its switch only when it does. It does where the app's iOS Live Activity module is linked (not on Android, not in the web preview).
import { liveActivityNative } from '../platform/liveActivity';

export const LIVE_ACTIVITY_AVAILABLE = liveActivityNative() !== null;
