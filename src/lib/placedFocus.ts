// Initial focus for anchored layers waits for placement and yields to disposal or a newer focus choice.
export function focusAfterPlacement(element: HTMLElement) {
  const before = document.activeElement;
  let current = true;
  let attempts = 0;
  let frame = 0;
  const take = () => {
    if (!current || !element.isConnected || document.activeElement !== before || element.contains(document.activeElement)) return;
    element.focus({ preventScroll: true });
    // A nested anchor may itself still be waiting for placement. Stop after ten frames if it never becomes available.
    if (document.activeElement !== element && ++attempts < 10) frame = requestAnimationFrame(take);
  };
  frame = requestAnimationFrame(take);
  return () => {
    current = false;
    cancelAnimationFrame(frame);
  };
}
