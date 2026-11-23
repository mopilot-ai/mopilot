// Control-matrix case discovery follows test helpers while retaining the runnable entrypoint for todo cases.
import { testCaseSources } from './test-case-sources.ts';

export function matrixCases(entries: string[], root: string) {
  const found: { id: string; todo: boolean; file: string }[] = [];
  for (const { entry, source } of testCaseSources(entries, root)) {
    const pattern = /\btest\(\s*(['"`])(CM-[A-Z]\d{2}[a-z]?):[\s\S]*?\1\s*,\s*(\{[^{}]*\btodo:)?/g;
    for (const match of source.matchAll(pattern)) found.push({ id: match[2], todo: !!match[3], file: entry });
  }
  return found;
}
