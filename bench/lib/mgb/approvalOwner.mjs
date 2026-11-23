// Keep the bench operator's asynchronous answer bound to the approval it inspected, including retries.

/** Locate input only while the same card, text and structured destination are still present. Serialized into the app. */
export function approvalPoint(document, card, how, scopeCards) {
  const c = document.querySelector('.approval-card');
  if (
    !c ||
    c.dataset.edgeToken !== card.token ||
    c.innerText.slice(0, 1200) !== card.text ||
    (c.querySelector('[data-action-target]')?.getAttribute('data-action-target') || 'null') !== JSON.stringify(card.actionTarget)
  )
    return null;
  let b;
  if (how === 'deny') b = c.querySelector('.ap-btn.deny');
  else if (how === 'read-only') {
    const radio = [...c.querySelectorAll('.sage-levels [role=radio]')].find((e) => /read only/i.test(e.innerText));
    if (!radio) return null;
    if (radio.getAttribute('aria-checked') !== 'true') b = radio;
  }
  if (!b && how !== 'deny') {
    const scoped = c.matches(scopeCards) && c.querySelector('.ap-split .chevron');
    const once =
      scoped && [...document.querySelectorAll('.popover-layer [role=menuitem]')].find((e) => /^Allow once/.test(e.innerText.trim()));
    b = c.classList.contains('question-card')
      ? [...c.querySelectorAll('button')].find((e) => /^skip/i.test(e.innerText.trim()))
      : once || scoped || c.querySelector('.ap-btn.allow') || c.querySelector('.btn.primary');
  }
  if (!b || b.disabled) return null;
  b.scrollIntoView({ block: 'center' });
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Cache the answer for this exact snapshot; a missed deny is retried as deny, never as allow. */
export async function answerOwnedApproval(card, { answers, answer, number, ev, click, scopeCards }) {
  const identity = JSON.stringify([card.token, card.text, card.actionTarget]);
  let how = answers.get(identity);
  if (!how) {
    how = answer && !card.q ? await answer(number, card.text, card.actionTarget, card.token) : 'allow';
    if (!['allow', 'deny', 'read-only'].includes(how)) how = 'deny';
    answers.set(identity, how);
  }
  const point = await ev(
    `(${approvalPoint.toString()})(document,${JSON.stringify(card)},${JSON.stringify(how)},${JSON.stringify(scopeCards)})`,
  ).catch(() => null);
  if (point) await click(point);
  return how;
}
