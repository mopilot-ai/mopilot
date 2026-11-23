// The page agent the browser tools inject into every frame: the accessibility-style outline (tree),
// find, text, locate, scrollTo, formInput and state, and the ref bookkeeping behind them. The real
// exported function runs against a happy-dom document installed on globalThis. happy-dom has no
// layout, so computed styles and boxes are stubbed per element.
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';

const require = createRequire(import.meta.url);
export const AGENT_PATH = require.resolve('../../../electron/capabilities/browser/pageAgent.cjs');
export const { pageAgent, PAGE_AGENT_SOURCE } = require(AGENT_PATH);

export const SVG = 'http://www.w3.org/2000/svg';
export const win: any = new Window({ url: 'https://site.test/start', width: 1024, height: 768 });
export const doc: any = win.document;
export const G: any = globalThis;
Object.assign(G, {
  document: doc,
  location: win.location,
  innerWidth: 1024,
  innerHeight: 768,
  devicePixelRatio: 2,
  scrollX: 0,
  scrollY: 40,
  MutationObserver: win.MutationObserver,
});
after(() => win.happyDOM.close());

/** Computed-style overrides, and elements whose style lookup fails. */
export const styles = new WeakMap<object, Record<string, string>>();
export const broken = new WeakSet<object>();
const INLINE = new Set(['span', 'b', 'i', 'em', 'strong', 'a', 'label', 'img', 'input', 'select', 'textarea', 'button', 'code']);
function patchWindow(w: any) {
  w.getComputedStyle = (el: any) => {
    if (broken.has(el)) throw new Error('style unavailable');
    return {
      display: INLINE.has(el.localName) ? 'inline' : 'block',
      visibility: 'visible',
      position: 'static',
      cursor: 'auto',
      paddingLeft: '0px',
      paddingTop: '0px',
      textTransform: 'none',
      ...styles.get(el),
    };
  };
  return w;
}
patchWindow(win);
export const css = (el: any, s: Record<string, string>) => {
  styles.set(el, { ...styles.get(el), ...s });
  return el;
};
export const box = (el: any, left: number, top: number, width = 50, height = 20) => {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
  return el;
};
export const define = (obj: any, key: string, desc: PropertyDescriptor) => Object.defineProperty(obj, key, { configurable: true, ...desc });

export const agent = pageAgent();
export const run = (op: string, args?: any) => agent.call(op, args).value;
export const shape = (lines: string[]) => lines.map((l) => l.replace(/ref_\d+/g, 'ref'));
export const load = (html: string) => {
  G.document = doc;
  doc.body.innerHTML = html;
  return (id: string) => doc.getElementById(id);
};
/** The ref at the end of the first line starting (after indentation) with `prefix`. */
export const refAt = (lines: string[], prefix: string) => {
  const line = lines.find((l) => l.trimStart().replace(/^- /, '').startsWith(prefix.replace(/^- /, '')));
  assert.ok(line, `no line starting with ${prefix} in\n${lines.join('\n')}`);
  return line.match(/\[(ref_\d+)\]$/)![1];
};
/** A same-origin iframe's document, with layout stubs on its window. */
export const frameDoc = (iframe: any, html: string) => {
  patchWindow(iframe.contentWindow);
  const d = iframe.contentDocument;
  d.body.innerHTML = html;
  return d;
};

export const query = (steps: any[], limit?: number) => run('query', limit ? { steps, limit } : { steps });
