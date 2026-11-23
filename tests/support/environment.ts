// What main resolves a project's environment to (electron/platform/environmentSource.cjs), for the fakes of env:resolve.

/** A project with no environment config, unless `over` says. */
export const resolvedEnvironment = (over: Record<string, unknown> = {}) => ({
  setup: '',
  cleanup: '',
  actions: [],
  copy: [],
  copySource: null,
  copyError: null,
  source: null,
  files: [],
  error: null,
  unreadable: [],
  notice: '',
  ...over,
});
