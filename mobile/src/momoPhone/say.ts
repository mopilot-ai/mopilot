// MoMo's phone words: every line the home screens show is a key of the app's catalog (`momoHome.*`, English and Simplified Chinese), read in the language shown now.
import { currentLocale, t } from '../ui/i18n';

type Vars = Record<string, string | number>;

/** The text of a `momoHome` key, `{{name}}` filled from `vars` (a `count` picks the plural form). */
export const say = (key: string, vars?: Vars): string => t(`momoHome.${key}`, vars);

/** "A", "A and B", "A, B and C": a list in the shown language. */
export function andList(items: readonly string[]): string {
  if (items.length < 2) return items.join('');
  return say('listAnd', { head: items.slice(0, -1).join(say('listComma')), last: items[items.length - 1] });
}

/** Sentences that follow one another, joined the way the shown language joins them. */
export const sentences = (...parts: string[]): string => parts.join(currentLocale() === 'zh-Hans' ? '' : ' ');
