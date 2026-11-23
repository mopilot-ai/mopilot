// Test-only database for the web preview: opening one fails, so callers use their fallback.
export const openDatabaseAsync = async () => {
  throw new Error('No database in the web preview');
};
