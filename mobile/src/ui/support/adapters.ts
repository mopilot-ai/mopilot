// The support pages' seam to the design system, the catalogs and the phone v2 flag: every other file in this folder reaches them only through here.
import { Easing, FadeInDown } from 'react-native-reanimated';
import { dur, ease, typo, useReducedMotionEnabled, useTokens } from '../ds';
import { t as translate, useTranslation } from '../i18n';

export { typo, useTokens };
export type Tokens = ReturnType<typeof useTokens>;

/** The words of this folder: `support.<key>` in both catalogs, `{{name}}` filled in. */
export const t = (key: string, vars: Record<string, string | number> = {}): string => translate(`support.${key}`, vars);

/** Call in a component that draws words: it draws again when the language changes. */
export const useLanguage = (): void => void useTranslation();

export { bindSupportFlag, supportV2 } from './supportFlag';

/** The entering animation of a row: it rises and fades in `index * 60` ms after it mounts, on the UI thread; none with Reduce Motion. */
export function useAppear(index: number) {
  const reduce = useReducedMotionEnabled();
  return reduce
    ? undefined
    : FadeInDown.delay(index * 60)
        .duration(dur.base)
        .easing(Easing.bezier(...ease.enter));
}
