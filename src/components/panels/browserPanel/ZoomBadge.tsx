// The address bar's page zoom: shown while the user zoomed the page's site (⌘+ / ⌘−), and clicked to fit the pane again.
import { useEffect, useState } from 'react';
import type { WebviewElement } from './ViewSurface';

/** Shown while the user zoomed this site (⌘+ / ⌘−); clicking it fits the page to the pane again. */
export function ZoomBadge({ page }: { page: WebviewElement | null }) {
  const [, changed] = useState(0);
  useEffect(() => {
    if (!page) return;
    const tell = () => changed((n) => n + 1);
    page.addEventListener('zoom-changed', tell);
    return () => page.removeEventListener('zoom-changed', tell);
  }, [page]);
  if (!page?.isZoomAuto || page.isZoomAuto()) return null;
  const percent = Math.round(page.getZoomFactor() * 100);
  return (
    <button className="browser-zoom" onClick={() => page.zoom?.('reset')} title="Fit to pane" aria-label={`Zoom ${percent}%, fit to pane`}>
      {percent}%
    </button>
  );
}
