// How a harness CLI install is named in Settings: its version, then how it was installed in words a person recognizes
// ("Native installer", "npm", "Homebrew", "Bundled with ChatGPT.app", "Installed manually", "Custom location").
// The path only goes in a tooltip. Main decides how each binary was installed (electron/harness/installMethod.cjs);
// these words are the one place every harness family and page turns that into text.
import type { HarnessVersionInfo } from './native/harnessUpdates';
import type { OffPathFields } from '../../shared/model/harness';
export type { OffPathFields } from '../../shared/model/harness';

type Via = HarnessVersionInfo['via'];

const VIA_WORDS: Record<Exclude<Via, 'app-bundle'>, string> = {
  self: 'Native installer',
  brew: 'Homebrew',
  npm: 'npm',
  bun: 'bun',
  pnpm: 'pnpm',
  unknown: 'Installed manually',
};

/** How main says an install was made, in words; null when main hasn't said (an older main, a read still under way). */
export function installSource(via: string | null | undefined, from?: string | null): string | null {
  if (!via) return null;
  if (via === 'app-bundle') return from ? `Bundled with ${from}` : 'Bundled with an app';
  // only main's own words count: a name it may add later (or nonsense) still reads as no known installer
  return Object.hasOwn(VIA_WORDS, via) ? VIA_WORDS[via as keyof typeof VIA_WORDS] : VIA_WORDS.unknown;
}

/** One install as main reports it: a binary, its version and how it was installed. */
export interface InstallLike {
  path: string;
  version: string | null;
  via?: string | null;
  from?: string | null;
}

/** The binary a harness's chats run, with what decides how it reads: the installs found and the path the user set. */
export interface HarnessBinary {
  bin: string | null;
  installs?: InstallLike[] | null;
  manual: string | null;
}

/**
 * The words for the binary in use, `bin`: "Custom location" when it is the path the user set and not one of the
 * installs found; else how that install, or main's update check of that same binary, says it was installed.
 */
export function sourceOfBin(
  bin: string | null | undefined,
  o: { installs?: InstallLike[] | null; manual?: string | null; checked?: { bin: string; via: string; from: string } | null },
): string | null {
  if (!bin) return null;
  const found = o.installs?.find((i) => i.path === bin);
  if (!found && o.manual && o.manual === bin) return 'Custom location';
  const fromInstall = installSource(found?.via, found?.from);
  if (fromInstall) return fromInstall;
  return o.checked?.bin === bin ? installSource(o.checked.via, o.checked.from) : null;
}

/** An install as one short line, no "v": "2.1.302 · Native installer". */
export const installLine = (version: string | null | undefined, source: string | null) =>
  [version ?? 'Version unknown', source].filter(Boolean).join(' · ');

/**
 * The line under a harness's version when the terminal runs a different `name` (or none), with both paths for the
 * tooltip; null when it runs the same one or can't be asked.
 */
export function offPathNote(name: string, bin: string | null | undefined, where: OffPathFields | null | undefined) {
  if (!bin || !where?.offPath) return null;
  return where.terminal
    ? { text: `Your terminal runs a different ${name}`, title: `MoPilot runs ${bin}\nYour terminal runs ${where.terminal}` }
    : { text: `${name} isn't on your terminal's PATH`, title: `MoPilot runs ${bin}, which your terminal's PATH doesn't reach` };
}
