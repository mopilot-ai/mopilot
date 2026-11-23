// The person's name for a chat on a machine (`chat.rename`, feature `chatName`): the feature both ends declare and the one rule for what a name may be, so the Mac, the phone and the Host read one contract.

/** The feature both ends declare before a rename is sent; an older Host is refused (feature_missing), never sent a request it would drop. */
export const NAME_FEATURE = 'chatName';

/** The longest name a chat may be given (the app's own title limit). */
export const NAME_MAX = 200;

/**
 * A chat's name as the wire takes it: text, trimmed, 1 to NAME_MAX characters and no control character.
 * @param {unknown} v @param {(message: string) => Error} bad
 */
export function nameOf(v, bad) {
  const name = typeof v === 'string' ? v.trim() : '';
  if (!name || name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) throw bad('Give the chat a name of 1 to 200 characters.');
  return name;
}
