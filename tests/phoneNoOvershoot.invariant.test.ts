// Nothing on the phone rises past its resting place and comes back: every spring token arrives without passing its target, no timed curve leaves 0..1, and every spring a component builds comes from a token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
// the phone stand-ins for expo and react-native, which motion.ts reaches through its haptics
import './support/phone/component-kit';

export const GUARDS = ['mobile/src/'];

const motionPath = '../mobile/src/motion';
const { spring, ease } = await import(motionPath);

type SpringConfig = { duration?: number; dampingRatio?: number; stiffness?: number; damping?: number; mass?: number };

/** How far a step response passes its target, as a fraction of the travel: 0 once the spring is critically damped or more. */
export function overshootOf(config: SpringConfig): number {
  const ratio = config.dampingRatio ?? (config.damping ?? 0) / (2 * Math.sqrt((config.stiffness ?? 0) * (config.mass ?? 1)));
  return ratio >= 1 ? 0 : Math.exp((-Math.PI * ratio) / Math.sqrt(1 - ratio * ratio));
}

test('every spring token arrives without passing its target', () => {
  const over = Object.entries(spring as Record<string, SpringConfig>)
    .map(([name, config]) => [name, overshootOf(config)] as const)
    .filter(([, passed]) => passed > 1e-6);
  assert.deepEqual(over, [], 'a sheet or a row that rises past its place and settles back looks like a bounce');
});

test('every timed curve stays between its ends', () => {
  const bad = Object.entries(ease as Record<string, readonly number[]>).filter(([, [, y1, , y2]]) => y1 < 0 || y1 > 1 || y2 < 0 || y2 > 1);
  assert.deepEqual(
    bad.map(([name]) => name),
    [],
  );
});

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [],
  );
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Where a component sets up its own motion instead of taking a token: a spring with its own numbers, or an easing that overshoots on purpose. */
export function motionOutsideTokens(sources: Record<string, string>): string[] {
  return Object.entries(sources)
    .filter(([file]) => !file.endsWith('motion.ts'))
    .flatMap(([file, source]) => {
      const code = withoutComments(source);
      const own = [...code.matchAll(/springify\(\)([^;]*)/g)].filter(([, chain]) => !/\bspring\./.test(chain));
      const springs = [...code.matchAll(/\b(?:withSpring|Animated\.spring)\(([^)]*)/g)].filter(([, args]) => !/\bspring\./.test(args));
      const bounces = [...code.matchAll(/Easing\.(?:elastic|bounce|back)\b/g)];
      return [...own, ...springs, ...bounces].map(() => file);
    });
}

test('every spring and easing a component uses comes from a token', () => {
  const sources = Object.fromEntries(files('mobile/src').map((file) => [file, readFileSync(file, 'utf8')]));
  assert.deepEqual(motionOutsideTokens(sources), []);
});

test('the scan names a spring with its own numbers and an easing that bounces, and passes token springs', () => {
  const own = 'const a = SlideInDown.springify().stiffness(300).damping(20);';
  assert.deepEqual(motionOutsideTokens({ 'a.tsx': own }), ['a.tsx']);
  assert.deepEqual(motionOutsideTokens({ 'a.tsx': 'x.value = withSpring(1, { damping: 8 });' }), ['a.tsx']);
  assert.deepEqual(motionOutsideTokens({ 'a.tsx': 'Animated.spring(v, { toValue: 1 }).start();' }), ['a.tsx']);
  assert.deepEqual(motionOutsideTokens({ 'a.tsx': 'FadeIn.easing(Easing.bounce);' }), ['a.tsx']);
  assert.deepEqual(motionOutsideTokens({ 'a.tsx': 'LinearTransition.springify().duration(spring.smooth.duration);' }), []);
  assert.deepEqual(motionOutsideTokens({ 'a.tsx': 'x.value = withSpring(1, spring.smooth);' }), []);
  assert.deepEqual(motionOutsideTokens({ 'motion.ts': own }), [], 'the tokens file defines them');
  assert.deepEqual(motionOutsideTokens({ 'a.tsx': `// ${own}\n/* withSpring(1, { damping: 2 }) */` }), [], 'a comment is not motion');
});

test('overshootOf: under 1 the step passes its target, at 1 or more it does not', () => {
  assert.ok(overshootOf({ dampingRatio: 0.88, duration: 500 }) > 0.002);
  assert.ok(overshootOf({ stiffness: 304.6, damping: 30.72, mass: 1 }) > 0.002, 'the sheet spring that shipped');
  assert.equal(overshootOf({ dampingRatio: 1, duration: 500 }), 0);
  assert.equal(overshootOf({ stiffness: 100, damping: 20, mass: 1 }), 0, 'exactly critical');
  assert.equal(overshootOf({ stiffness: 100, damping: 40, mass: 1 }), 0, 'over-damped');
});

test('no component uses a spring-driven SlideIn* entering (it starts from a stale position and overshoots)', () => {
  const offenders = files('mobile/src').filter((file) =>
    /\bSlideIn(?:Down|Up|Left|Right)\b/.test(withoutComments(readFileSync(file, 'utf8'))),
  );
  assert.deepEqual(offenders, []);
});
