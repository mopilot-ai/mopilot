// Selects an installed Swift 6.2+ toolchain for the isolated Expo native check without changing xcode-select globally.
import path from 'node:path';

/** Probe the active developer directory first, then installed Xcode apps; propagate the selected environment to nested builds. */
export function phoneSendToolchain({ applications, active, probe, env }) {
  const candidates = [
    ...new Set(
      [
        active,
        ...applications
          .filter((name) => /^Xcode.*\.app$/.test(name))
          .sort()
          .map((name) => path.join('/Applications', name, 'Contents/Developer')),
      ].filter(Boolean),
    ),
  ];
  const diagnostics = [];
  for (const developer of candidates) {
    const candidateEnv = { ...env, DEVELOPER_DIR: developer };
    try {
      const output = probe(candidateEnv);
      const version = /Swift version (\d+)\.(\d+)/.exec(output);
      if (version && (Number(version[1]) > 6 || (Number(version[1]) === 6 && Number(version[2]) >= 2))) return candidateEnv;
      diagnostics.push(`${developer}: ${version ? `${version[1]}.${version[2]}` : 'unrecognized Swift version'}`);
    } catch {
      diagnostics.push(`${developer}: probe failed`);
    }
  }
  throw new Error(`Native Expo check requires an installed Swift 6.2+ toolchain. ${diagnostics.join('; ')}`);
}
