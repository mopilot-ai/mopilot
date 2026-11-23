// MoMo's motion tokens (shared/momoMotion.mjs, MoMo's design §6): the design's table, the custom properties the Mac's shell declares (src/components/momo/shell/momoShell.module.css) held equal to it so the two clients cannot drift, and the Mac's arrival rules honouring Reduce Motion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { MOMO_DUR, MOMO_EASE, MOMO_THREAD, cssCurve, momoMotionVars } from '../shared/momoMotion.mjs';

export const GUARDS = ['src/components/momo/', 'mobile/src/screens/MomoShell.tsx'];

const css = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('the tokens are the design’s table', () => {
  assert.deepEqual(MOMO_DUR, { xs: 60, s: 120, m: 200, l: 300, xl: 450 });
  assert.deepEqual(MOMO_THREAD, { rise: 175, dots: 140, arrive: 210 }, 'the design’s thread timings');
  assert.deepEqual(MOMO_EASE.out, [0.165, 0.84, 0.44, 1]);
  assert.deepEqual(MOMO_EASE.snap, [0.32, 0.72, 0, 1]);
  assert.deepEqual(MOMO_EASE.overshoot, [0.34, 1.3, 0.64, 1]);
  assert.equal(cssCurve('snap'), 'cubic-bezier(0.32, 0.72, 0, 1)');
  assert.ok(Object.isFrozen(MOMO_DUR) && Object.isFrozen(MOMO_EASE) && Object.isFrozen(MOMO_EASE.out));
});

test('the Mac’s custom properties are the tokens: a value changed in one place and not the other fails here', () => {
  const declared: Record<string, string> = {};
  postcss.parse(css('src/components/momo/shell/momoShell.module.css')).walkRules('.shell', (rule) => {
    rule.walkDecls(/^--momo-/, (decl) => void (declared[decl.prop] = decl.value));
  });
  assert.deepEqual(declared, momoMotionVars());
  assert.equal(Object.keys(declared).length, 11);
});

test('the chat’s arrival rules take their duration and curve from the tokens, and stand still with Reduce Motion', () => {
  const root = postcss.parse(css('src/components/momo/momoChat.module.css'));
  const arrival: string[] = [];
  root.walkDecls('animation', (decl) => {
    if (/wholeIn|thinkingIn/.test(decl.value)) arrival.push(decl.value);
  });
  assert.equal(arrival.length, 2);
  assert.match(arrival.join('\n'), /thinkingIn var\(--momo-thread-dots, 140ms\) var\(--momo-ease-out, ease-out\)/);
  assert.match(arrival.join('\n'), /wholeIn var\(--momo-thread-arrive, 210ms\) var\(--momo-ease-out, ease-out\)/);
  const still: string[] = [];
  root.walkAtRules('media', (media) => {
    if (!media.params.includes('prefers-reduced-motion')) return;
    media.walkRules((rule) => void still.push(rule.selector));
  });
  assert.match(still.join('\n'), /\.thinking/);
  assert.match(still.join('\n'), /\.chat :global\(\[data-arrive\]\)/);
  // the shell moves only its centre, over the 200 ms token and out curve (the design's #main-content padding); the rail and pane themselves appear at once; Reduce Motion stops it
  const shell = postcss.parse(css('src/components/momo/shell/momoShell.module.css'));
  const moving: string[] = [];
  shell.walkDecls(/^(animation|transition)/, (d) => void moving.push(d.value));
  assert.equal(moving.length, 3, 'two slides and the reduced-motion stop');
  for (const value of moving.filter((v) => v !== 'none')) assert.match(value, /var\(--momo-dur-m\) var\(--momo-ease-out\)/);
  const stilled: string[] = [];
  shell.walkAtRules('media', (media) => {
    if (media.params.includes('prefers-reduced-motion')) media.walkRules((rule) => void stilled.push(rule.selector));
  });
  assert.match(stilled.join('\n'), /data-tween/);
});
