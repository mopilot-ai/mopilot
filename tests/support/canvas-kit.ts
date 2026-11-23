// Evaluate a known test artifact against the production canvas import boundary and render its real React controls.
import vm from 'node:vm';
import { createElement as h } from 'react';
import { compileCanvas } from '../../src/lib/canvas/compile.ts';
import { canvasRequire } from '../../src/lib/canvas/runtime.tsx';
import { CanvasContext, canvasEnvironment } from '../../src/lib/canvas/context.tsx';
import { render } from './shell-panels-kit.ts';

export function authoredCanvas(source: string) {
  const module = { exports: {} as { default: any } };
  vm.runInNewContext(compileCanvas(source), { require: canvasRequire, module, exports: module.exports, React: canvasRequire('react') });
  return module.exports.default;
}
export function renderCanvasSource(source: string) {
  return render(h(CanvasContext.Provider, { value: canvasEnvironment(false, {}, () => {}) }, h(authoredCanvas(source))));
}
