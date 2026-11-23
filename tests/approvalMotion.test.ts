// Approval cards come in as Claude Desktop's do (src/styles/app/approvals.css): its code-approval-promote animation,
// .22s cubic-bezier(.215,.61,.355,1) from opacity .75, 6px up and .97 scale, anchored at the top, off with reduced
// motion; and each card in the stack is keyed by its request, so the next one in the queue plays it again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { appCss } from './support/app-css.ts';
import { cssRules } from './support/css-rules.ts';
import { ghostCount } from '../src/components/thread/approvalLogic.ts';

const css = postcss.parse(appCss());
const { decls } = cssRules(css);

test("an approval card enters with Claude Desktop's promote animation, from the top", () => {
  const card = decls('.approval-card');
  assert.equal(card.animation, 'approval-promote 0.22s cubic-bezier(0.215, 0.61, 0.355, 1)');
  assert.equal(card['transform-origin'], 'top');
  const steps: string[] = [];
  css.walkAtRules('keyframes', (a) => {
    if (a.params !== 'approval-promote') return;
    a.walkRules((r) => {
      const d: string[] = [];
      r.walkDecls((x) => void d.push(`${x.prop}:${x.value}`));
      steps.push(`${r.selector}{${d.join(';')}}`);
    });
  });
  assert.deepEqual(steps, ['0%{opacity:0.75;transform:translateY(-6px) scale(0.97)}', 'to{opacity:1;transform:none}']);
});

test('with reduced motion an approval card appears without the animation', () => {
  let off = false;
  css.walkAtRules('media', (m) => {
    if (!m.params.includes('prefers-reduced-motion: reduce')) return;
    m.walkRules((r) => {
      if (r.selectors.includes('.approval-card') && r.nodes.some((n) => n.type === 'decl' && n.prop === 'animation' && n.value === 'none'))
        off = true;
    });
  });
  assert.ok(off);
});

test('every card in the stack is keyed by its request, so the next queued card mounts afresh and plays the animation', () => {
  const src = readFileSync(new URL('../src/components/thread/Approvals.tsx', import.meta.url), 'utf8');
  const stack = src.slice(src.indexOf('<div className="approval-stack">'), src.indexOf('className="approval-queue"'));
  const cards = stack.match(/<(ApprovalCard|DesktopAccessCard|DevServerCard|BrowserPermissionCard|SageApprovalCard)\b[^>]*>/g) ?? [];
  assert.equal(cards.length, 5);
  for (const c of cards) assert.match(c, /\bkey=\{/, c);
});

test('queued cards show as ghosts behind the shown card, Claude Desktop numbers per card: 6px up, .03 smaller, .25 fainter', () => {
  const ghost = decls('.approval-ghost');
  assert.equal(ghost.transform, 'translateY(calc(var(--n) * -6px)) scale(calc(1 - var(--n) * 0.03))');
  assert.equal(ghost.opacity, 'calc(1 - var(--n) * 0.25)');
  assert.equal(ghost['transform-origin'], 'top');
  assert.equal(decls('.approval-ghosts')['z-index'], '-1');
  assert.equal(decls('.approval-stack').isolation, 'isolate');
  assert.equal(decls('.approval-stack').position, 'relative');
});

test('one ghost per waiting card, at most two, none for a lone card', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(ghostCount), [0, 0, 1, 2, 2, 2]);
});
