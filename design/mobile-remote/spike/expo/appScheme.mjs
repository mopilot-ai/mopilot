// Select the generated Expo app's exact Xcode scheme; workspace order also contains unrelated Pod schemes.
/** @param {string[]} entries @param {string[]} schemes */
export function selectAppScheme(entries, schemes) {
  const projects = entries.filter((name) => name.endsWith('.xcodeproj') && name !== 'Pods.xcodeproj');
  if (projects.length !== 1) throw new Error('expected exactly one app Xcode project');
  const scheme = projects[0].slice(0, -'.xcodeproj'.length);
  if (!schemes.includes(scheme)) throw new Error('app scheme missing from workspace');
  return scheme;
}
