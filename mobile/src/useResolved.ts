// A value the app is handed as a promise (a cache opened from disk at launch), as state: null until it resolves, and null for good if it fails.
import { useEffect, useState } from 'react';

export function useResolved<T>(setup: Promise<T | null> | undefined): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    setup?.then(
      (resolved) => live && setValue(resolved),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [setup]);
  return value;
}
