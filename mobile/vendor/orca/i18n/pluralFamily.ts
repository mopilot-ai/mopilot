import type { TOptions } from 'i18next'

const PLURAL_SUFFIX_RE = /_(zero|one|two|few|many|other)$/

// A caller may name a literal `_one`/`_other` key; with a count, let CLDR pick the form.
export function resolvePluralFamilyKey(key: string, options?: TOptions): string {
  return typeof options?.count === 'number' ? key.replace(PLURAL_SUFFIX_RE, '') : key
}
