// How the Chats home is arranged: by project, as the Mac's sidebar is, or by state. The choice is kept on this phone and read when the app starts.
export type HomeLayout = 'project' | 'state';
export const HOME_LAYOUTS: readonly HomeLayout[] = ['project', 'state'];
export const HOME_LAYOUT_WORD: Record<HomeLayout, string> = { project: 'By project', state: 'By state' };

/** The layout the person never chose: by project, as the Mac's sidebar. Anything unreadable is that too, so a bad store never hides the projects. */
export const DEFAULT_LAYOUT: HomeLayout = 'project';
export const parseHomeLayout = (raw: string | null): HomeLayout => HOME_LAYOUTS.find((l) => l === raw) ?? DEFAULT_LAYOUT;

export interface HomeLayoutControl {
  read(): Promise<HomeLayout>;
  /** Keep the choice; rejects when it could not be kept. */
  set(value: HomeLayout): Promise<void>;
}

/** The control over a string store. */
export function createHomeLayout(o: { store: { read(): Promise<string | null>; write(value: string): Promise<void> } }): HomeLayoutControl {
  return {
    async read() {
      return parseHomeLayout(await o.store.read().catch(() => null));
    },
    async set(value) {
      await o.store.write(value);
    },
  };
}
