// Composer menus share visible space above the composer or its toolbar, following scrolling, drafts and viewport resizes.

/** Observe for this panel document's lifetime; without ResizeObserver the stylesheet keeps its viewport cap. */
export function trackMenuSpace(/** @type {any} */ document) {
  const Observer = document.defaultView?.ResizeObserver;
  if (!Observer) return;
  const composer = document.getElementById('composer');
  const update = () => {
    const top = composer.getBoundingClientRect().top;
    // Leave room for a heading and a choice; a tall form can scroll up while its toolbar remains visible.
    const anchorTop = top < 96 ? document.getElementById('plus').getBoundingClientRect().top : top;
    // Even a hidden anchor retains the popup's padding/border floor plus the outer margins.
    const edge = Math.max(32, Math.min(anchorTop, document.defaultView.innerHeight - 6));
    // Menus are out of flow: these bounds cannot resize their owner. Inner menu scrolling needs no duplicate writes.
    for (const [name, value] of [
      ['--menu-space', Math.floor(edge) - 12],
      ['--menu-shift', edge - top],
    ]) {
      const px = `${value}px`;
      if (composer.style.getPropertyValue(name) !== px) composer.style.setProperty(name, px);
    }
  };
  const observer = new Observer(update);
  observer.observe(composer);
  observer.observe(document.documentElement);
  document.addEventListener('scroll', update, true);
  update();
}
