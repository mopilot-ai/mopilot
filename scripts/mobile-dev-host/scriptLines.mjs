// The words of the dev host's scripted turn that depend on what the message carried, so the review demo never quotes empty text.

/**
 * The scripted turn's first line: it names the pictures a message came with, and has nothing to quote when the message is only a picture.
 * @param {string} prompt the message's text (may be empty)
 * @param {number} pictures how many pictures came with it (a text file is not one)
 */
export function openingLine(prompt, pictures) {
  const got = pictures > 0 ? `Got your ${pictures === 1 ? 'picture' : `${pictures} pictures`}. ` : '';
  const about = prompt.trim().slice(0, 60);
  return about
    ? `${got}I'll check the repository state first, then summarize what I find for "${about}".`
    : `${got}I'll check the repository state first.`;
}
