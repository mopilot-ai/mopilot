// Hold-to-talk for the dictation shortcut: a press held past HOLD_MS stops the dictation it started when the keys come
// up; a quicker tap leaves it recording until the next press. Leaving the window ends the hold without stopping.
export const HOLD_MS = 300;

/** Watches the shortcut's release after it started a dictation; `stop` ends that dictation. Returns the disarm. */
export function holdToTalk(stop: () => void, now: () => number = Date.now): () => void {
  const pressed = now();
  const disarm = () => {
    window.removeEventListener('keyup', up, true);
    window.removeEventListener('blur', disarm);
  };
  function up() {
    disarm();
    if (now() - pressed >= HOLD_MS) stop();
  }
  window.addEventListener('keyup', up, true);
  window.addEventListener('blur', disarm);
  return disarm;
}
