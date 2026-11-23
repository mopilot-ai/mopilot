// App diff readers need original contents and repository-relative a/ and b/ paths.
export const GIT_DIFF_FLAGS = Object.freeze([
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-relative',
  '--src-prefix=a/',
  '--dst-prefix=b/',
]);
