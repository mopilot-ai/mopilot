// The renderer's composition root for the native port: it installs window.native, imported first by the entry
// (src/launch.ts) so it runs before any module that uses the bridge. It is the one module that reads window.native.
import { installNative } from './native';

installNative(window.native);
