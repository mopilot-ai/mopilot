// Every duration, delay, curve and spring on the phone is a token from mobile/src/motion.ts: no literal number in an animation anywhere else, except the few listed here, which can only be removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const src = path.join(import.meta.dirname, '..', 'mobile', 'src');

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) && e.name !== 'motion.ts' ? [p] : [];
  });

// a number written where a duration, a delay, a curve or a spring parameter goes; a computed value (`duration: dur.base`, `delay`) is not a literal
const NUMBER = String.raw`-?\d`;
const LITERAL = new RegExp(
  [
    String.raw`\b(?:duration|animationDuration|animationDelay|transitionDuration|transitionDelay|delay)\s*:\s*${NUMBER}`,
    String.raw`\.(?:duration|delay|damping|stiffness|mass)\(\s*${NUMBER}`,
    String.raw`\bEasing\.[a-zA-Z]+\(\s*${NUMBER}`,
    String.raw`\bcubicBezier\(\s*${NUMBER}`,
    String.raw`\b(?:damping|stiffness|mass|dampingRatio|response)\s*:\s*${NUMBER}`,
    String.raw`\bwithDelay\(\s*${NUMBER}`,
    String.raw`\bAnimated\.(?:timing|spring)\b`,
    String.raw`\b(?:FADE|RISE|SLIDE|ANIM|SPIN|REVEAL|PULSE)_MS\s*=\s*${NUMBER}`,
  ].join('|'),
);

/** The literals that remain, each with whose file it is; remove an entry when its file moves to a token (the test fails on an entry that no longer matches). */
const KNOWN: { file: string; line: string; owner: string }[] = [
  { file: 'components/Motion.tsx', line: 'animationDuration: 1900,', owner: 'phone-polish-thread: the thinking dots' },
  { file: 'presentation/wordFade.ts', line: 'export const FADE_MS = 400;', owner: 'phone-polish-thread: the streamed-text fade' },
];

const hits = (): { file: string; line: string }[] =>
  sources(src).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => LITERAL.test(l))
      .map((l) => ({ file: path.relative(src, file), line: l.trim() })),
  );

test('no animation outside mobile/src/motion.ts writes its own duration, delay, curve or spring number', () => {
  const unknown = hits().filter((h) => !KNOWN.some((k) => k.file === h.file && k.line === h.line));
  assert.deepEqual(
    unknown.map((h) => `${h.file}: ${h.line}`),
    [],
    'take the number from dur, ease or spring in mobile/src/motion.ts (add a token there if none fits)',
  );
});

test('the list of known literals only shrinks: every entry still matches a line', () => {
  const found = hits();
  for (const k of KNOWN)
    assert.ok(
      found.some((h) => h.file === k.file && h.line === k.line),
      `${k.file}: "${k.line}" is gone; remove it from KNOWN (${k.owner})`,
    );
});

test('the pattern recognises what it is there to forbid', () => {
  for (const bad of [
    'withTiming(1, { duration: 250 })',
    'FadeIn.duration(250)',
    'Easing.bezier(0.2, 0, 0, 1)',
    'withSpring(1, { damping: 20, stiffness: 200 })',
    'style={{ animationDuration: 900 }}',
    'Animated.timing(v, { toValue: 1 })',
    'const SLIDE_MS = 300;',
  ])
    assert.ok(LITERAL.test(bad), bad);
  for (const fine of [
    'withTiming(1, { duration: dur.sheet, easing: Easing.bezier(...ease.snap) })',
    'FadeIn.duration(dur.base)',
    'withSpring(1, { ...spring.drawer, velocity })',
    'const SAVE_AFTER_MS = 1500;',
    'animationDelay: delay,',
  ])
    assert.ok(!LITERAL.test(fine), fine);
});
