// Which of Electron's Chromium locale files a package keeps: those an interface language serves (shared/i18n/languages.mjs).
// Chromium ships about 55 languages (220 folders on macOS, with gendered variants); MoPilot's interface speaks 12, so the rest
// only translate Chromium's own few strings for a person who sees the app in English. Chromium falls back to en-US for a
// locale it has no file for. A language added to the interface keeps its Chromium locales without a change here.
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { languageOfLocale } from '../shared/i18n/languages.mjs';

const GENDERED = /_(FEMININE|MASCULINE|NEUTER)$/;

/** Whether a Chromium locale ('en_GB', 'pt-BR', 'zh_TW_FEMININE') is one an interface language serves. @param {string} locale */
export const keptLocale = (locale) => languageOfLocale(locale.replace(GENDERED, '')) !== null;

/**
 * The folders holding Chromium's locales in a staged app, from packager's buildPath (the app folder that becomes app.asar).
 * macOS: the framework's `<locale>.lproj` and the app's own, which tell macOS the languages the app has, so it never picks
 * one whose Chromium file is gone. Windows and Linux: `locales/<locale>.pak` beside the executable.
 * @param {'darwin' | 'win32' | 'linux'} platform @param {string} buildPath
 * @returns {Array<{ dir: string, suffix: string }>}
 */
export function localeFolders(platform, buildPath) {
  if (platform !== 'darwin') return [{ dir: path.resolve(buildPath, '../../locales'), suffix: '.pak' }];
  const contents = path.resolve(buildPath, '../..');
  return [
    { dir: path.join(contents, 'Frameworks', 'Electron Framework.framework', 'Resources'), suffix: '.lproj' },
    { dir: path.join(contents, 'Resources'), suffix: '.lproj' },
  ];
}

/**
 * Removes the locales no interface language serves. A folder with no English locale is refused: Electron's layout changed,
 * and Chromium would have nothing to fall back to.
 * @param {{ platform: 'darwin' | 'win32' | 'linux', buildPath: string }} at
 * @param {{ readdirSync: (dir: string) => string[], rmSync: typeof rmSync }} [fs]
 * @returns {{ kept: number, removed: number }}
 */
export function stripChromiumLocales({ platform, buildPath }, fs = { readdirSync, rmSync }) {
  let kept = 0;
  let removed = 0;
  for (const { dir, suffix } of localeFolders(platform, buildPath)) {
    const locales = fs.readdirSync(dir).filter((name) => name.endsWith(suffix));
    const locale = (/** @type {string} */ name) => name.slice(0, -suffix.length);
    if (!locales.some((name) => languageOfLocale(locale(name)) === 'en'))
      throw new Error(`No English Chromium locale (*${suffix}) in ${dir}: Electron's layout changed, so no locale was removed.`);
    for (const name of locales) {
      if (keptLocale(locale(name))) kept += 1;
      else {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        removed += 1;
      }
    }
  }
  return { kept, removed };
}
