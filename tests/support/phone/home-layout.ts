// The Chats home's layout in the tests of one arrangement: the saved choice the app is given, and a list that holds the folds with the layout fixed.
import { createElement } from './component-kit';
import type { HomeLayout } from '../../../mobile/src/homeLayout';

/** The saved choice of the person, as the app reads it. */
export const savedLayout = (layout: HomeLayout) => ({ read: async () => layout, set: async () => undefined });
export const BY_STATE = savedLayout('state');
export const BY_PROJECT = savedLayout('project');

/**
 * The home list with its folds kept as the app keeps them and the layout fixed (the chosen one is there at once, not after a read).
 * `useHomeFolds` comes from the test's own import of it, so it is the React the test draws with.
 */
export const withLayout = (list: any, useHomeFolds: () => object, layout: HomeLayout) =>
  function LayoutList(props: Record<string, unknown>) {
    const folds = useHomeFolds();
    return createElement(list, { ...props, folds: { ...folds, layout } });
  };
