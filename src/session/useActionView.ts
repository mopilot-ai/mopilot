// Own only an action's UI completion; accepted effects and their failures outlive the view.
import { useLayoutEffect, useMemo } from 'react';
import { useStore } from '../store/core';
import { sameView, viewToken } from '../store/split';

// Navigation is window-wide even when two task cards remain mounted.
let latestAction: object | null = null;

export function useActionView(identity: unknown) {
  const owner = useMemo(() => {
    let active = false;
    let generation = 0;
    return {
      identity,
      activate() {
        active = true;
      },
      retire() {
        active = false;
        generation++;
      },
      invalidate() {
        generation++;
      },
      begin(navigates = true) {
        const own = ++generation;
        const action = {};
        if (navigates) latestAction = action;
        return () => active && generation === own && (!navigates || latestAction === action);
      },
    };
  }, [identity]);
  useLayoutEffect(() => {
    owner.activate();
    let view = viewToken(useStore.getState());
    let pane = useStore.getState().paneActive;
    const off = useStore.subscribe(() => {
      const state = useStore.getState();
      if (!sameView(view, viewToken(state)) || pane !== state.paneActive) owner.invalidate();
      view = viewToken(state);
      pane = state.paneActive;
    });
    return () => {
      owner.retire();
      off();
    };
  }, [owner]);
  return owner;
}
