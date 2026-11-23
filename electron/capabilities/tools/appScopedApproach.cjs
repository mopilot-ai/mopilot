// The phantom cursor's part of a background desktop_app_* input action: its approach to where the action lands, and its exit when the action fails.

/** @typedef {InstanceType<typeof import('./appScoped.cjs').AppScopedControl>} AppScopedControl the control the cursor belongs to */

/**
 * The phantom cursor's approach to where the action lands (the same for every harness; the input goes when it has arrived), then
 * waits again if the user took the app over meanwhile. Stop ends the wait, and the request's own check then refuses the input.
 * Only an action run on its own gets this: a step inside desktop_app_batch, and desktop_app_script, Shortcuts, OCR and the file panel,
 * show no pre-click cursor (a batch step's arrow appears after the fact, appVisibility.acted).
 * @param {AppScopedControl} control
 */
async function approach(control, c, action, { w, t, points }) {
  const at = action === 'drag' ? points.map(([x, y]) => ({ x, y })) : t?.point ? [t.point] : [];
  await control.visibility?.approach(c.chatId, {
    app: { bundleId: c.app.bundleId, name: c.app.name },
    bounds: w?.bounds ?? null,
    state: w?.state ?? null,
    action,
    points: at,
    token: c.cursorToken,
  });
  await control.waitForUser(c);
}

/**
 * Runs `run` after the cursor's approach. The action gets a token that every report of it carries (c.cursorToken, read by report()), so
 * a retry or an escalation that reports twice touches the cursor once. When the approach or the action does not run to a result, the
 * cursor goes now, not when it would have timed out.
 * @param {AppScopedControl} control
 */
async function withCursor(control, c, action, r, run) {
  c.cursorToken = {};
  // a click carries this id to the helper, which answers it early (click.dispatched) when the mouse-down goes out
  c.cursorSignal = control.visibility?.signalFor?.(c.chatId, c.cursorToken) ?? null;
  try {
    await approach(control, c, action, r);
    return await run();
  } catch (e) {
    control.visibility?.interrupted(c.chatId, c.cursorToken);
    throw e;
  }
}

/** The requests that end the cursor early: a click (the helper says so as its mouse-down goes out) and an accessibility press (as the press has been performed). Both are answered only after the helper's settle. */
const SIGNALLED = new Set(['app.click', 'app.press']);

/** A click's or press's request carries the cursor's signal (made when the approach began, after the plan was built): the helper answers it early, as the input goes out. Other requests, and ones with no signal, go as planned. */
function signClick(c, plan) {
  return SIGNALLED.has(plan.method) && c.cursorSignal ? { ...plan, params: { ...plan.params, signal: c.cursorSignal } } : plan;
}

/**
 * The ladder's first request. An app in front ignores events posted to its process, so with brief foreground allowed (`fgOk`) a coordinate click asks the helper to take the
 * real-pointer route at once when the app is in front as the click runs (`ifFrontmost`); the result then carries `foreground` and there is no higher rung to try.
 */
function firstPlan(p, thumb, fgOk) {
  return { ...p, params: { ...p.params, ...thumb, ...(fgOk && p.method === 'app.click' ? { ifFrontmost: true } : {}) } };
}

/** Whether the helper refused the brief-foreground path the first request asked for (the user is at the mouse or keyboard, the screen is locked): nothing was posted, so the plain background click is still to try. */
function foregroundRefused(e) {
  return /^(unsupported\(user_active\)|refused.*locked screen)/i.test(String(e?.message ?? ''));
}

module.exports = { withCursor, signClick, firstPlan, foregroundRefused };
