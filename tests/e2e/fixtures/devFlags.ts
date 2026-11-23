// The MOPILOT_FLAGS a launch gets: the `@dev` preset (every flag in development on) plus what the spec names.

/**
 * A spec's own MOPILOT_FLAGS list is added after `@dev`, so a key it names wins (`x=0` pins x off). A JSON value is a
 * complete override and is passed as it is, without the preset: a spec that wants no flag in development on passes `{}`.
 */
export function withDevFlags(value: string | undefined): string {
  const own = (value ?? '').trim();
  if (!own) return '@dev';
  if (own.startsWith('{') || own.split(',').some((p) => p.trim() === '@dev')) return own;
  return `@dev,${own}`;
}
