// The Live Activity names and limits the Mac, the relay and the phone agree on, in one place. The activity carries counts, a kind, a start time and
// up to three rows; a row label is the fixed text of its kind unless the person turned chat titles on, then a sealed title the widget opens.

/** The wire message a phone sends the relay with its activity's push-to-update token (hex), and the one that removes it. */
export const ACTIVITY_REGISTER = 'activity.register';
export const ACTIVITY_UNREGISTER = 'activity.unregister';
/** The wire message a Mac sends the relay with a snapshot of its chats. */
export const ACTIVITY_UPDATE = 'activity';

export const ACTIVITY_KINDS = Object.freeze(['needs', 'running', 'done']);
export const ACTIVITY_MAX_ROWS = 3;
export const ACTIVITY_MAX_COUNT = 99;
/** Longest sealed row label, in characters, that the relay forwards. */
export const ACTIVITY_MAX_ROW_SEALED = 700;

/** What a row (and the lock screen's headline) reads without chat titles: the same strings as the fixed push titles. */
export const ACTIVITY_FIXED_TEXT = Object.freeze({
  needs: 'A chat needs you',
  running: 'A chat is running',
  done: 'A chat finished',
});

/** The App Group key the phone writes with the "Chat titles on lock screen" switch, which the widget reads; absent means off. */
export const ACTIVITY_TITLES_KEY = 'liveActivityTitles';
