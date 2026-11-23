// MoPilot's Chrome extension service worker entry (design D5, B2 step 2): starts the background in the worker's global scope.
import { startBackground } from './src/background.mjs';

startBackground(globalThis);
