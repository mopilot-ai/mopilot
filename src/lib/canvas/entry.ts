// Bootstrap the bundled canvas runtime from the document's inert, escaped input payload.
import { canvasRuntime } from './runtime';
const input = JSON.parse(document.getElementById('canvas-input')!.textContent!);
Object.assign(window, { MoPilotCanvas: canvasRuntime(window, document.getElementById('canvas-root')!, input) });
