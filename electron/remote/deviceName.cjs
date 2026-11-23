// A phone's name as people read it (the confirmation card, Settings, the terminal switch): the phone chooses this text, so it may not reorder, hide or fake what is around it.
const MAX_NAME = 60;
// characters that draw nothing but are letters or symbols to Unicode, so a name of only these would look empty: Hangul fillers, braille blank, combining grapheme joiner, Khmer inherent vowels
const BLANK = /[\u115F\u1160\u17B4\u17B5\u034F\u2800\u3164\uFFA0]/g;
const segmenter = new Intl.Segmenter();

/**
 * Control and line characters become spaces; format characters (right-to-left overrides, zero-width marks, so also the joiner inside a family
 * emoji, which then shows as separate emoji) and blank fillers are dropped; more than two combining marks on one character are cut; spaces
 * are collapsed; the rest is cut to MAX_NAME whole characters as a reader counts them. Empty when nothing a reader can see is left or `name`
 * is not text.
 * @param {unknown} name
 */
function cleanDeviceName(name) {
  if (typeof name !== 'string') return '';
  const text = name
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\p{Cf}/gu, '')
    .replace(BLANK, '')
    .replace(/(\p{M}{2})\p{M}+/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/[\p{L}\p{N}\p{S}\p{P}]/u.test(text)) return '';
  return Array.from(segmenter.segment(text), (part) => part.segment)
    .slice(0, MAX_NAME)
    .join('')
    .trim();
}

module.exports = { cleanDeviceName, MAX_NAME };
