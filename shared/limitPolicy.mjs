// Independent usage-limit preferences shared by the main continuation service, Settings and chat notices.

/** Resume on the same harness after its quota resets; retain the existing default and saved choices. */
export function resumeAfterQuotaReset(prefs) {
  return prefs?.autoContinueOnLimit !== false;
}

/** Switching to another harness needs its own explicit opt-in, including for existing installations. */
export function switchHarnessAtLimit(prefs) {
  return prefs?.autoSwitchHarnessOnLimit === true;
}
