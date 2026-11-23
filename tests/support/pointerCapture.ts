// Pointer capture for the test DOM, which has none: which element holds which pointer, with the calls a drag makes.
const captures = new WeakMap<object, number>();
const proto = (globalThis as any).HTMLElement.prototype;
proto.setPointerCapture = function (id: number) {
  captures.set(this, id);
};
proto.hasPointerCapture = function (id: number) {
  return captures.get(this) === id;
};
proto.releasePointerCapture = function () {
  captures.delete(this);
};
/** A pointer event as the browser sends it to a captured edge: the mouse's id, its main button, and held during a move, unless told otherwise. */
export const pointerEvent = (type: string, init: Record<string, unknown> = {}) =>
  new (globalThis as any).PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    button: 0,
    buttons: type === 'pointermove' ? 1 : 0,
    ...init,
  });
