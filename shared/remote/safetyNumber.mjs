// How the pairing safety number is shown, so the Mac and the phone read the same text: grouped for comparing, digit by digit for a screen reader.
const digits = (/** @type {string} */ number) => number.replace(/\D/g, '');

/** "12345678901234567890" as "1234 5678 9012 3456 7890" (a run of any other length in threes, as before); anything that is not a run of digits is shown as it came. */
export function groupSafety(/** @type {string | null | undefined} */ number) {
  if (!number) return '';
  const d = digits(number);
  if (d.length === 0 || d.length !== number.length) return number;
  const size = d.length === 20 ? 4 : 3;
  return /** @type {string[]} */ (d.match(new RegExp(`.{1,${size}}`, 'g'))).join(' ');
}

/** "1234" as "1 2 3 4", so each digit is spoken on its own. */
export const speakSafety = (/** @type {string} */ number) => digits(number).split('').join(' ');
