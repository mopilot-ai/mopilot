// MoPilot's Chrome extension side panel entry: starts the panel in its window.
import { startSidePanel } from './src/sidePanel.mjs';
import { PanelChrome } from './src/panelChrome.mjs';

const presentation = new PanelChrome(globalThis);
globalThis.addEventListener('pagehide', () => presentation.close(), { once: true });
startSidePanel(globalThis);
