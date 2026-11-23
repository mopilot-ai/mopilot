// Types of shared/i18n/languages.mjs: the interface languages and which one a preference means.
export const SYSTEM_LANGUAGE: 'system';
export interface InterfaceLanguage {
  tag: string;
  name: string;
}
export const LANGUAGES: InterfaceLanguage[];
export const HOLE: RegExp;
export function fillHoles(message: string, values: readonly unknown[]): string;
export function languageOfLocale(locale: string): string | null;
export function resolveLanguage(preference: unknown, systemLocales: readonly string[]): string;
