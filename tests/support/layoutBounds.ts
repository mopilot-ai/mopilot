// Shared rendered-control collision checks allow wrapped rows while rejecting actual rectangle intersections.
export interface LayoutBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function controlsAreSeparate(controls: readonly LayoutBounds[]): boolean {
  return controls.every((control, i) =>
    controls
      .slice(i + 1)
      .every(
        (other) => control.right <= other.left || other.right <= control.left || control.bottom <= other.top || other.bottom <= control.top,
      ),
  );
}
