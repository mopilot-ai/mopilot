// Shared Xcode project edit of the extension plugins: adds an app-extension target with its sources, resources, group, dependency and build settings.
// xcode is @expo/config-plugins' dependency, not the app's: resolved from there
const PBXFile = require(require.resolve('xcode/lib/pbxFile', { paths: [require.resolve('@expo/config-plugins')] }));

/** The library compares quoted names, so find a target by its unquoted name. */
function findTarget(project, name) {
  return Object.values(project.pbxNativeTargetSection()).find((t) => typeof t === 'object' && t.name?.replace(/"/g, '') === name);
}

/**
 * Add the extension target to an Xcode project once. Files are named relative to ios/<name>/; the Info.plist and entitlements join the group.
 * @param {any} project
 * @param {{ name: string, bundleId: string, sources: string[], resources: string[], buildSettings: Record<string, unknown> }} spec
 */
function addAppExtension(project, spec) {
  const { name } = spec;
  if (findTarget(project, name)) return project;
  // The template has neither section, and the library skips the app's dependency on the new target silently without them. With them
  // addTarget adds that dependency itself, so it is never added by hand: a second extension would otherwise be depended on twice.
  const objects = project.hash.project.objects;
  objects.PBXTargetDependency ??= {};
  objects.PBXContainerItemProxy ??= {};
  const target = project.addTarget(name, 'app_extension', name, spec.bundleId);
  project.addBuildPhase(spec.sources.map((f) => `${name}/${f}`), 'PBXSourcesBuildPhase', 'Sources', target.uuid);
  project.addBuildPhase(spec.resources.map((f) => `${name}/${f}`), 'PBXResourcesBuildPhase', 'Resources', target.uuid);
  project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);
  const group = addOwnGroup(project, [...spec.sources, `${name}-Info.plist`, `${name}.entitlements`, ...spec.resources], name);
  const main = project.getFirstProject().firstProject.mainGroup;
  project.addToPbxGroup(group.uuid, main);
  const configs = project.pbxXCBuildConfigurationSection();
  const list = project.pbxNativeTargetSection()[target.uuid].buildConfigurationList;
  for (const entry of project.pbxXCConfigurationList()[list].buildConfigurations) {
    Object.assign(configs[entry.value].buildSettings, spec.buildSettings);
  }
  return project;
}

/**
 * A group with a new file reference for each file. addPbxGroup reuses any reference whose path matches, so a file name two extensions
 * share (SealedTitle.swift, PrivacyInfo.xcprivacy) would sit in both groups, which Xcode 27 refuses to open.
 */
function addOwnGroup(project, paths, name) {
  const group = project.addPbxGroup([], name, name);
  for (const path of paths) {
    const file = new PBXFile(path);
    file.fileRef = project.generateUuid();
    project.addToPbxFileReferenceSection(file);
    group.pbxGroup.children.push({ value: file.fileRef, comment: file.basename });
  }
  return group;
}

module.exports = { addAppExtension, findTarget };
