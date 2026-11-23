// Settings search lands on the setting: finds the row a search hit named on the open page, scrolls to it and flashes it.

/**
 * The row a search word names: the word, minus a ": detail" ("Follow-up behavior: Queue or Steer", with a full-width colon in Chinese), is its title. A
 * title with a badge after the name ("Models" + "Codex") still counts, after an exact one.
 */
export function matchRow(titles: readonly string[], target: string): number {
  const want = target
    .split(/[:\uff1a]/)[0]
    .trim()
    .toLowerCase();
  if (!want) return -1;
  const low = titles.map((t) => t.trim().toLowerCase());
  const exact = low.indexOf(want);
  return exact >= 0 ? exact : low.findIndex((t) => t.startsWith(want));
}

export interface FocusRow {
  textContent: string | null;
  closest(selector: string): FocusRoot | null;
}
export interface FocusRoot {
  scrollIntoView(options: { block: 'center' }): void;
  classList: { add(name: string): void; remove(name: string): void };
}
interface TitleScope {
  querySelectorAll(selector: string): ArrayLike<FocusRow>;
}

export const FOUND_CLASS = 'settings-row-found';
/** Rows draw once their data has loaded: look this many frames, then give up. */
const TRIES = 40;
const FLASH_MS = 1800;

/**
 * Looks for the row titled `target` under `scope` (again on each frame while the page is still drawing), scrolls it to
 * the middle and marks it for a moment. Returns a cancel for when the page changes first.
 */
export function focusSettingRow(
  scope: TitleScope,
  target: string,
  env: {
    frame: (run: () => void) => number;
    cancelFrame: (id: number) => void;
    later: (run: () => void, ms: number) => number;
    cancelLater: (id: number) => void;
  },
): () => void {
  let frame = 0;
  let timer = 0;
  let stopped = false;
  let marked: FocusRoot | null = null;
  const look = (left: number) => {
    if (stopped) return;
    const titles = Array.from(scope.querySelectorAll('.settings-row-title'));
    const at = matchRow(
      titles.map((t) => t.textContent ?? ''),
      target,
    );
    const row = at < 0 ? null : titles[at].closest('.settings-row');
    if (!row) {
      if (left > 1) frame = env.frame(() => look(left - 1));
      return;
    }
    row.scrollIntoView({ block: 'center' });
    marked = row;
    row.classList.add(FOUND_CLASS);
    timer = env.later(() => row.classList.remove(FOUND_CLASS), FLASH_MS);
  };
  look(TRIES);
  return () => {
    stopped = true;
    env.cancelFrame(frame);
    env.cancelLater(timer);
    marked?.classList.remove(FOUND_CLASS);
  };
}
