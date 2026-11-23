// A happy-dom window installed as the global DOM, for rendering components with react-dom/client.
import { after } from 'node:test';
import { Window } from 'happy-dom';

export const window = new Window({ url: 'http://localhost/' });
const GLOBALS = [
  'window',
  'document',
  'navigator',
  'location',
  'Node',
  'NodeFilter',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLButtonElement',
  'Text',
  'DocumentFragment',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'KeyboardEvent',
  'InputEvent',
  'FocusEvent',
  'PointerEvent',
  'CompositionEvent',
  'ClipboardEvent',
  'DragEvent',
  'MutationObserver',
  'ResizeObserver',
  'IntersectionObserver',
  'getComputedStyle',
  'DOMParser',
  'Range',
  'Selection',
  'localStorage',
  'sessionStorage',
  'matchMedia',
];
for (const name of GLOBALS) {
  const value = name === 'window' ? window : (window as any)[name];
  if (value !== undefined)
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: typeof value === 'function' && /^[a-z]/.test(name) ? value.bind(window) : value,
    });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).requestAnimationFrame ??= (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number;
(globalThis as any).cancelAnimationFrame ??= (id: number) => clearTimeout(id);
after(() => window.happyDOM.abort());
