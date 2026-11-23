// The window's width, followed across resizes, so saved panel widths are clamped to the window they show in.
import { useEffect, useState } from 'react';

export function useViewportWidth() {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return width;
}
