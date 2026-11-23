// DEV ONLY: where each chat's agent works (a browser page or a desktop app), as the fake Mac answers `surface.current`; set by the `surface` scenario.

export function createSurfaces() {
  /** @type {Map<string, object>} */
  const surfaces = new Map();
  return {
    /** {} before the chat's first browser or desktop step, as the Mac answers. */
    of: (/** @type {string} */ chatId) => surfaces.get(chatId) ?? {},
    /** Says where a chat's agent works, or clears it with null. */
    set(/** @type {string} */ chatId, /** @type {object | null} */ surface) {
      if (surface) surfaces.set(chatId, surface);
      else surfaces.delete(chatId);
    },
  };
}
