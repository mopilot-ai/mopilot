const ACCENTED: Readonly<Record<string, string>> = {
  a: 'á',
  e: 'é',
  i: 'í',
  o: 'ó',
  u: 'ú',
  A: 'Á',
  E: 'É',
  I: 'Í',
  O: 'Ó',
  U: 'Ú',
  c: 'ç',
  n: 'ñ'
}

// Bracket padding makes untranslated or clipped strings obvious during QA; `expand` also
// accents letters and adds ~40% length, the growth longer languages typically need.
export function pseudoLocalizeString(value: string, options?: { expand?: boolean }): string {
  if (!value || value.startsWith('[')) {
    return value
  }
  if (!options?.expand) {
    return `[${value}]`
  }
  const accented = value.replace(/[aeiouAEIOUcn]/g, (letter) => ACCENTED[letter] ?? letter)
  return `[${accented}${'·'.repeat(Math.ceil(value.length * 0.4))}]`
}
