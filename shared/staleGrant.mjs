// The advice for a macOS privacy switch that is on yet still refused: it belongs to an older copy of the app.
/**
 * System Settings lists an app by name, but macOS checks the switch against the copy (its code signature) that was
 * there when the app was first added; once a differently signed copy replaces it, the switch stays on and the app is
 * still refused. Removing and re-adding the app is the only way to point the switch at the copy installed now.
 * @param {string} app the app's name as System Settings lists it
 * @param {string} list the Privacy & Security list, e.g. "Full Disk Access"
 * @param {string} then what to do after adding it back
 */
export function staleGrantHint(app, list, then = `quit and reopen ${app}`) {
  return `Already on? It may still belong to an older copy of ${app}: in ${list}, select ${app}, remove it with −, add it again with +, then ${then}.`;
}
