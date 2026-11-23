// Resolve test source stand-ins by their module URL so extracted modules share the same fake boundaries.
const withoutExtension = (url: string) => url.replace(/\.(?:[cm]?[jt]s|tsx)$/, '');

export function moduleSourceFakes(sources: Record<string, string>, from: URL) {
  const modules = new Map(
    Object.entries(sources).map(([specifier, source]) => [
      specifier.startsWith('.') ? withoutExtension(new URL(specifier, from).href) : specifier,
      source,
    ]),
  );
  return (specifier: string, parentURL?: string) => {
    const key = specifier.startsWith('.') && parentURL ? withoutExtension(new URL(specifier, parentURL).href) : specifier;
    return modules.get(key);
  };
}
