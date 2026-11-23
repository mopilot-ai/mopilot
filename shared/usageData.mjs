// Quality improvement sharing defaults on; an explicit opt-out is the only off state.
/** @param {unknown} value */
export function shareUsageDataEnabled(value) {
  return value !== false;
}
