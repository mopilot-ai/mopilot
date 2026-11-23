// The Chats home's folds (the sub-sessions shown under a parent, and how far each project's list is revealed) and its layout, held above the list so they stay as they were when a chat is opened and closed again.
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { DEFAULT_LAYOUT, type HomeLayout, type HomeLayoutControl } from './homeLayout';

export type HomeFolds = {
  /** The chats whose sub-sessions are shown. */
  unfolded: string[];
  setUnfolded: Dispatch<SetStateAction<string[]>>;
  /** By project: how many chats of each project (by its key) "Show more" has revealed beyond the first ones. */
  revealed: Record<string, number>;
  reveal: (key: string, count: number) => void;
  /** By project (the Mac's sidebar) or by state; the choice is kept on the phone. */
  layout: HomeLayout;
  setLayout: (next: HomeLayout) => void;
};

/** The saved layout is read once; a choice made while it is still being read wins over it, and one that could not be kept is shown as it was. */
export function useHomeFolds(saved?: HomeLayoutControl): HomeFolds {
  const [unfolded, setUnfolded] = useState<string[]>([]);
  const [revealed, setRevealed] = useState<Record<string, number>>({});
  const reveal = useCallback((key: string, count: number) => setRevealed((old) => ({ ...old, [key]: count })), []);
  const [layout, show] = useState<HomeLayout>(DEFAULT_LAYOUT);
  const chosen = useRef(false);
  useEffect(() => {
    let live = true;
    void saved?.read().then((value) => live && !chosen.current && show(value));
    return () => {
      live = false;
    };
  }, [saved]);
  const setLayout = useCallback(
    (next: HomeLayout) => {
      const before = layout;
      chosen.current = true;
      show(next);
      saved?.set(next).catch(() => show(before));
    },
    [layout, saved],
  );
  // the same object until a fold or the layout changes: the home is drawn again for a change of its folds, not for every render of the app
  return useMemo(() => ({ unfolded, setUnfolded, revealed, reveal, layout, setLayout }), [unfolded, revealed, reveal, layout, setLayout]);
}
