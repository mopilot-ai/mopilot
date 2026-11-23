// The version Settings › About shows, read from the Expo config the build was made with.
/** What Settings › About shows: the version, and the commit the build was made from when it carries one. */
export const displayVersion = (constants: {
  expoConfig?: { version?: string; extra?: { buildCommit?: unknown } } | null;
}): string | undefined => {
  const version = constants.expoConfig?.version;
  const commit = constants.expoConfig?.extra?.buildCommit;
  return version && typeof commit === 'string' ? `${version} (${commit})` : version;
};

export const appVersion = (constants: { expoConfig?: { version?: string } | null }): string | undefined => constants.expoConfig?.version;
