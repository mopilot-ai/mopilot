// Dependency-free installed-Biome path candidates for conservative test selection, never ownership enforcement.
// Decode source escapes without interpreting syntax: inert programs may add edges, but ordinary mentions of
// Biome or unrelated Unicode escapes must not make core app modules depend on the lint configuration.
export function mayHaveBiomeExecutable(/** @type {string} */ text) {
  const decoded = text.replace(
    /\\(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2})|([0-7]{1,3})|(\r\n|[\r\n\u2028\u2029])|([^\r\n\u2028\u2029]))/gi,
    (escape, point, unicode, hex, octal, continuation, identity) => {
      if (continuation) return '';
      if (identity) return identity;
      const code = Number.parseInt(point ?? unicode ?? hex ?? octal, octal ? 8 : 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : escape;
    },
  );
  // Path.join/resolve can separate the pieces into arguments; require installed-path evidence in the same source.
  return /(?:\.bin|@biomejs)(?:['"`]|[/\\][^'"`\r\n]*biome(?:\.(?:cmd|exe))?['"`])/.test(decoded) && /biome/.test(decoded);
}
