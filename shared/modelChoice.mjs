// A durable automatic model choice outranks a native receipt; explicit picks and inherited defaults remain distinct.

/** A saved null means Automatic, even after the native session reports the model its last turn used. */
export function chatModelChoice(saved, reported, fallback) {
  return saved?.model === null ? null : (reported ?? saved?.model ?? fallback);
}

/** Resolve Automatic against the current recommendation before falling back to an older native configuration. */
export function effectiveModel(selected, recommended, configured = null) {
  return selected ?? recommended ?? configured ?? null;
}
