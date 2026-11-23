// The app's own glyphs (src/components/ui/icons.tsx): default sizes, overrides and pass-through props, and the
// thinking dots with the motion their stylesheet gives them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import postcss from 'postcss';
import * as icons from '../src/components/ui/icons.tsx';
import { readAppCssPart } from './support/app-css.ts';

const svg = (C: any, props: object = {}) => {
  const html = renderToStaticMarkup(createElement(C, props));
  const tag = /^<svg([^>]*)>/.exec(html)![1];
  const attr = (n: string) => new RegExp(`\\s${n}="([^"]*)"`).exec(tag)?.[1];
  return { html, attr };
};

test('the shared spinner uses the Codex three-quarter arc and quiet two-second rotation', () => {
  const icon = svg(icons.Spinner);
  assert.equal(icon.attr('viewBox'), '0 0 24 24');
  assert.equal(icon.attr('aria-hidden'), 'true');
  assert.match(icon.html, /<circle[^>]*r="7"[^>]*stroke-opacity=".3"[^>]*stroke-width="2"/);
  assert.match(icon.html, /<path d="M12 5a7 7 0 1 1-7 7"[^>]*stroke-width="2"/);
  assert.doesNotMatch(icon.html, /stroke-linecap="round"/);
  const css = readAppCssPart('app/base.css');
  assert.match(css, /\.spinner\s*\{[^}]*animation: spin 2s steps\(60, end\) infinite;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.spinner\s*\{\s*animation: none;/);
});

const markup = (C: any, props: object = {}) => renderToStaticMarkup(createElement(C, props));

test('the thinking glyph is three dots of its own size, staggered by the stylesheet', () => {
  const dots = markup(icons.ThinkingDots);
  assert.match(dots, /^<span class="thinking-dots" style="--dot-size:6px" aria-hidden="true">/);
  assert.equal(dots.match(/<span><\/span>/g)?.length, 3);
  assert.match(markup(icons.ThinkingDots, { size: 5 }), /--dot-size:5px/);
});

test("the thinking glyph reads in MoPilot's own colours, with the reference's timings and an opt-out", () => {
  const css = postcss.parse(readAppCssPart('app/motion.css'));
  /** The declarations of the rules that list `selector`, inside the `media` query (none for a top-level rule). */
  const decls = (selector: string, media = ''): Record<string, string> => {
    const out: Record<string, string> = {};
    css.walkRules((r) => {
      const at = r.parent?.type === 'atrule' ? (r.parent as postcss.AtRule).params : '';
      if (r.selectors.includes(selector) && at === media) r.walkDecls((d) => void (out[d.prop] = d.value));
    });
    return out;
  };
  // the reference is Anthropic-branded clay; thinking reads in MoPilot's accent, never --text-4, which measures
  // about 3.3:1 below 16px and fails the non-text contrast floor
  assert.equal(decls('.thinking-dots > span').background, 'var(--accent)');
  // the reference's clay stays where it belongs: Claude Code's own four-dot working glyph, not this vocabulary
  assert.doesNotMatch(JSON.stringify(decls('.thinking-dots > span')), /#d97757|--text-4/);
  // the reference's own timings: 1.9s dots staggered 0s / .15s / .3s
  assert.equal(decls('.thinking-dots > span').animation, 'timeline-quiet-dot 1.9s cubic-bezier(0.4, 0, 0.2, 1) infinite');
  assert.equal(decls('.thinking-dots > span:nth-child(2)')['animation-delay'], '0.15s');
  assert.equal(decls('.thinking-dots > span:nth-child(3)')['animation-delay'], '0.3s');
  // the hop itself, as the reference writes it
  const quiet: Record<string, string>[] = [];
  css.walkAtRules('keyframes', (at) => {
    if (at.params !== 'timeline-quiet-dot') return;
    at.walkRules((r) => {
      const step: Record<string, string> = { at: r.selectors.join(',') };
      r.walkDecls((d) => void (step[d.prop] = d.value));
      quiet.push(step);
    });
  });
  assert.deepEqual(quiet, [
    { at: '0%,8%', opacity: '0.2', transform: 'translateY(2px)' },
    { at: '22%', opacity: '1', transform: 'translateY(-2.5px)' },
    { at: '36%,70%', opacity: '1', transform: 'translateY(0)' },
    { at: '90%,100%', opacity: '0.2', transform: 'translateY(0)' },
  ]);
  // with motion off each glyph keeps its shape and loses only its motion, so a locked-open section still reads
  const REDUCE = '(prefers-reduced-motion: reduce)';
  assert.deepEqual(decls('.thinking-dots > span', REDUCE), { animation: 'none', opacity: '1' });
});

test('each glyph renders an svg at its default size and at a given size', () => {
  const defaults: [keyof typeof icons, number][] = [
    ['CodexMark', 56],
    ['MoPilotMark', 56],
    ['GithubMark', 16],
    ['Waveform', 16],
    ['Spinner', 14],
    ['SummaryIcon', 17],
    ['ShieldTerminal', 16],
    ['DiffSquare', 16],
    ['PythonLogo', 16],
  ];
  for (const [name, size] of defaults) {
    assert.equal(svg(icons[name]).attr('width'), String(size), name);
    assert.equal(svg(icons[name], { size: 30 }).attr('height'), '30', name);
  }
});

test('marks pass extra svg props through; the diff square takes a stroke width', () => {
  assert.equal(svg(icons.CodexMark, { className: 'hero' }).attr('class'), 'hero');
  assert.equal(svg(icons.GithubMark, { 'aria-label': 'GitHub' }).attr('aria-label'), 'GitHub');
  assert.match(svg(icons.DiffSquare, { strokeWidth: 2 }).html, /stroke-width="2"/);
  assert.match(svg(icons.DiffSquare).html, /stroke-width="1.6"/);
  assert.equal(svg(icons.Spinner).attr('class'), 'spinner');
});

test("MoPilot's mark is the app icon: a decorative dark tile with an orange >_, its border heavier when small", () => {
  const big = svg(icons.MoPilotMark, { className: 'hero' });
  assert.equal(big.attr('class'), 'hero');
  assert.equal(big.attr('aria-hidden'), 'true');
  assert.match(big.html, /<rect[^>]*fill="#1f1f1f"[^>]*stroke-width="1.5"/);
  assert.match(big.html, /<path d="M28 34 L44 50 L28 66 M52 66 H70"[^>]*stroke="#ef8b57"/);
  assert.match(svg(icons.MoPilotMark, { size: 24 }).html, /<rect[^>]*stroke-width="3"/);
});

test('the side chat glyph is the lucide bubble mirrored, keeping other styles', () => {
  const { attr } = svg(icons.SideChatIcon, { size: 20, style: { color: 'red' } });
  assert.equal(attr('width'), '20');
  assert.equal(attr('style'), 'transform:scaleX(-1);color:red');
  assert.equal(svg(icons.SideChatIcon).attr('style'), 'transform:scaleX(-1)');
});
