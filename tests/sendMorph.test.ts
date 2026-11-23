// The composer's send / stop / voice morph (src/lib/sendMorph.ts, src/styles/app/composer.css): which transition
// plays for each change, and its durations, keyframe times, values and per-segment ease, off with reduced motion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { appCss } from './support/app-css.ts';
import { cssRules } from './support/css-rules.ts';
import { sendMorph } from '../src/lib/sendMorph.ts';

const css = postcss.parse(appCss());
const { decls, keyframes } = cssRules(css);

const EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';
const anim = (selector: string) => decls(selector).animation.replace(/\s+/g, ' ').trim();

test('each change of the button picks its transition', () => {
  assert.equal(sendMorph('send', 'send'), null);
  assert.equal(sendMorph('send', 'stop'), 'to-stop');
  assert.equal(sendMorph('voice', 'stop'), 'to-stop');
  assert.equal(sendMorph('stop', 'send'), 'stop-to-send');
  assert.equal(sendMorph('voice', 'send'), 'voice-to-send');
  assert.equal(sendMorph('send', 'voice'), 'to-voice');
  assert.equal(sendMorph('stop', 'voice'), 'to-voice');
});

test('to and from stop: turn and lift over .5s, the new glyph in over .35s after .05s', () => {
  assert.equal(
    anim(".send-btn[data-morph='to-stop'] > svg"),
    `send-turn-to-stop 0.5s ${EASE}, send-lift-to-stop 0.5s ${EASE}, send-glyph-in 0.35s ${EASE} 0.05s both`,
  );
  assert.equal(
    anim(".send-btn[data-morph='stop-to-send'] > svg"),
    `send-turn-from-stop 0.5s ${EASE}, send-lift-from-stop 0.5s ${EASE}, send-glyph-in 0.35s ${EASE} 0.05s both`,
  );
  // rotate keyed at 0/.75/1; lift and scale at 0/.25/.75/1
  assert.equal(keyframes('send-turn-to-stop'), '0%{rotate:0deg}75%{rotate:100deg}100%{rotate:90deg}');
  assert.equal(
    keyframes('send-lift-to-stop'),
    '0%{translate:0 0;scale:1}25%{translate:0 -2px;scale:1.06}75%{translate:0 0;scale:0.97}100%{translate:0 0;scale:1}',
  );
  assert.equal(keyframes('send-turn-from-stop'), '0%{rotate:90deg}75%{rotate:-8deg}100%{rotate:0deg}');
  assert.equal(
    keyframes('send-lift-from-stop'),
    '0%{translate:0 0;scale:1}25%{translate:0 0.5px;scale:0.95}75%{translate:0 -1px;scale:1.03}100%{translate:0 0;scale:1}',
  );
  assert.equal(keyframes('send-glyph-in'), 'from{opacity:0}');
});

test('to and from voice: a .5s wobble keyed at 0/.25/.75/1, the glyph in over .22s', () => {
  assert.equal(anim(".send-btn[data-morph='to-voice'] > svg"), `send-wobble-to-voice 0.5s ${EASE}, send-glyph-in 0.22s ${EASE} both`);
  assert.equal(
    anim(".send-btn[data-morph='voice-to-send'] > svg"),
    `send-wobble-from-voice 0.5s ${EASE}, send-glyph-in 0.22s ${EASE} both`,
  );
  assert.equal(
    keyframes('send-wobble-to-voice'),
    '0%{rotate:0deg;translate:0 0;scale:1}25%{rotate:4deg;translate:0 -0.5px;scale:0.92}75%{rotate:-1deg;translate:0 0.5px;scale:1.04}100%{rotate:0deg;translate:0 0;scale:1}',
  );
  assert.equal(
    keyframes('send-wobble-from-voice'),
    '0%{rotate:0deg;translate:0 0;scale:1}25%{rotate:-4deg;translate:0 0.5px;scale:0.9}75%{rotate:1deg;translate:0 -1px;scale:1.05}100%{rotate:0deg;translate:0 0;scale:1}',
  );
});

test('with reduced motion the glyph swaps without a morph', () => {
  let off = false;
  css.walkAtRules('media', (m) => {
    if (!m.params.includes('prefers-reduced-motion: reduce')) return;
    m.walkRules((r) => {
      if (
        r.selectors.includes('.send-btn[data-morph] > svg') &&
        r.nodes.some((n) => n.type === 'decl' && n.prop === 'animation' && n.value === 'none')
      )
        off = true;
    });
  });
  assert.ok(off);
});
