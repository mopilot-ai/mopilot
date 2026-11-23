// Display text for URI encoding: replace unpaired UTF-16 units without changing identifiers or paths.

/** Unicode mode matches lone surrogates here, while valid pairs remain a single code point outside the range. */
export const wellFormedUriText = (text) => text.replace(/[\uD800-\uDFFF]/gu, '\uFFFD');
