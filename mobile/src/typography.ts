// The phone's one type scale: every Text size, weight and line height comes from here (see designs/mopilot-ios-typography).

/**
 * Sizes and line heights follow Apple's text styles, the scale Claude for iOS and ChatGPT for iOS both sit on, so a
 * user's Larger Text setting scales them the same way (React Native scales `fontSize` and `lineHeight` together by the
 * system font scale; nothing here sets `allowFontScaling` off). Letter spacing is left to the system face: SF Pro applies
 * its own size-dependent tracking, and writing a value here would be added on top of it.
 */
/** The text-style fields a token sets; structurally a subset of React Native's TextStyle, kept local so this file (and the root typecheck that reaches it from a test) needs no react-native types. */
export type TypeStyle = { fontSize?: number; lineHeight?: number; fontWeight?: '400' | '500' | '600' | '700'; letterSpacing?: number };
type Base = { fontSize: number; lineHeight: number };
type Weight = NonNullable<TypeStyle['fontWeight']>;

const REGULAR: Weight = '400';
const MEDIUM: Weight = '500';
const SEMIBOLD: Weight = '600';
const BOLD: Weight = '700';

const base = {
  caption2: { fontSize: 11, lineHeight: 13 },
  caption: { fontSize: 12, lineHeight: 16 },
  footnote: { fontSize: 13, lineHeight: 18 },
  subhead: { fontSize: 15, lineHeight: 20 },
  callout: { fontSize: 16, lineHeight: 21 },
  body: { fontSize: 17, lineHeight: 23 },
  /** an assistant's reply: the same 17 pt with the looser leading long reading needs */
  reply: { fontSize: 17, lineHeight: 26 },
  title3: { fontSize: 20, lineHeight: 25 },
  title2: { fontSize: 22, lineHeight: 28 },
  title1: { fontSize: 28, lineHeight: 34 },
  largeTitle: { fontSize: 34, lineHeight: 41 },
} satisfies Record<string, Base>;

type Name = keyof typeof base;
const weighted = (name: Name, weight: Weight): TypeStyle => ({ ...base[name], fontWeight: weight });

const build = () => {
  const out = {} as Record<string, TypeStyle>;
  for (const name of Object.keys(base) as Name[]) {
    out[name] = weighted(name, REGULAR);
    out[`${name}Medium`] = weighted(name, MEDIUM);
    out[`${name}Semibold`] = weighted(name, SEMIBOLD);
    out[`${name}Bold`] = weighted(name, BOLD);
  }
  return out;
};

type Variants<N extends string> = N | `${N}Medium` | `${N}Semibold` | `${N}Bold`;

/** `...typo.subhead`, `...typo.footnoteMedium`, `...typo.title1Bold`: size, line height and weight in one spread. */
export const typo = build() as Record<Variants<Name>, TypeStyle>;

/** Small caps-style section label (uppercase is the caller's); the only style with its own tracking. */
export const typoEyebrow: TypeStyle = { ...base.caption, fontWeight: SEMIBOLD, letterSpacing: 0.6 };

export const typoScale = base;

/** A weight for text that keeps the surrounding size (a bold lead-in, a selected tab). */
export const typoWeight = { regular: REGULAR, medium: MEDIUM, semibold: SEMIBOLD, bold: BOLD } as const;

/** Markdown heading depth 1..6 to a token: the reply's own size steps, never below body. */
export const typoHeading: Record<number, TypeStyle> = {
  1: { ...base.title2, fontWeight: SEMIBOLD },
  2: { ...base.title3, fontWeight: SEMIBOLD },
  3: { ...base.body, fontWeight: SEMIBOLD },
  4: { ...base.body, fontWeight: SEMIBOLD },
  5: { ...base.subhead, fontWeight: SEMIBOLD },
  6: { ...base.subhead, fontWeight: SEMIBOLD },
};
