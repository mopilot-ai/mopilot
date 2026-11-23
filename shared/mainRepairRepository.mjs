// Validates the GitHub repository identity persisted in repair authority and used by Git Database operations.
export const validRepository = (value) =>
  typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value) && !value.split('/').some((part) => part === '.' || part === '..');
export function githubRepo(remote) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
    remote.trim(),
  );
  return match && validRepository(match[1]) ? match[1].toLowerCase() : null;
}
