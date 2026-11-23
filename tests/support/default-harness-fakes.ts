// The store's default-harness accessors for tests that mock src/store/store: the saved pref from the fake state's
// prefs (Codex when unset), written through the mock's own setPrefs, and resolved with the real rule.
import type { HarnessKind } from '../../shared/model/harness';
import { defaultHarnessNote, resolveDefaultHarness } from '../../src/harness/defaultHarness.ts';

/**
 * `get` reads the fake state, `setPrefs` is the mock's recorder. A state may say what can run (`usable`, `pending`,
 * `basicHarnesses`); without them Codex and Claude Code both can, so the saved default is what runs.
 */
export function defaultHarnessExports(get: () => any, setPrefs: (p: any) => void) {
  const saved = (s: any = get()) => s?.prefs?.defaultHarness ?? 'codex';
  const resolveFor = (kind: HarnessKind, s: any) =>
    resolveDefaultHarness({
      saved: kind,
      usable: s?.usable ?? { codex: true, claude: true },
      pending: s?.pending ?? { codex: false, claude: false },
      basics: s?.basicHarnesses ?? [],
    });
  // what new chats start on: this draft's pick in the model picker, else the saved default
  const resolve = (s: any = get()) => resolveFor(s?.newChatHarnessPick ?? saved(s), s);
  return {
    savedDefaultHarness: saved,
    defaultHarness: resolve,
    savedDefaultResolved: (s: any = get()) => resolveFor(saved(s), s),
    defaultHarnessFallbackNote: (s: any = get()) => defaultHarnessNote(resolve(s)),
    setDefaultHarness: (kind: string) => setPrefs({ defaultHarness: kind }),
    // starting a first-tier harness left idle is the store's (tests/chooseDefaultHarness.test.ts): here, the pick
    chooseDefaultHarness: (kind: string) => setPrefs({ defaultHarness: kind }),
  };
}
