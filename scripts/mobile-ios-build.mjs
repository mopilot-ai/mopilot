// Xcode arguments for the isolated phone simulator build; simulator entitlements must be generated at build time.
/** @param {{workspace: string, scheme: string, derived: string}} o */
export function simulatorBuildArgs({ workspace, scheme, derived }) {
  return [
    '-workspace',
    workspace,
    '-scheme',
    scheme,
    '-configuration',
    'Release',
    '-sdk',
    'iphonesimulator',
    '-destination',
    'generic/platform=iOS Simulator',
    '-derivedDataPath',
    derived,
    'CODE_SIGNING_ALLOWED=YES',
    'CODE_SIGN_IDENTITY=-',
    'build',
  ];
}
