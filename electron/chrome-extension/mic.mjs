// MoPilot's Chrome extension microphone page entry: asks for the microphone Dictate in the side panel uses.
import { startMicPage } from './src/micPage.mjs';

// the page asks at once; what Chrome answered shows on the page
void startMicPage(globalThis);
