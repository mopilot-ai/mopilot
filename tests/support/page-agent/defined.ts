// happy-dom never matches `:defined` (Chromium does, per the HTML spec): an element is defined unless it is a custom
// element whose name its window has not defined. The page agent's closed-root probing (pageAgentShadow.cjs) reads it.
export function supportDefined(w: any) {
  const proto = w.Element.prototype;
  if (proto.__definedPatched) return;
  const matches = proto.matches;
  proto.matches = function (this: any, selector: string) {
    if (selector !== ':defined') return matches.call(this, selector);
    const view = this.ownerDocument.defaultView;
    return !this.localName.includes('-') || !!view?.customElements.get(this.localName);
  };
  proto.__definedPatched = true;
}
