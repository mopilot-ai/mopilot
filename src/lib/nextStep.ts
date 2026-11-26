// The composer's suggested follow-up, with browser and desktop recovery decided from the turn's tool calls.
//
// No model call: the suggestion comes from what the turn's control steps did, read the same way for
// every harness (MoPilot's browser_* and desktop_* tools under any namespace, vendor tools through the
// narration adapters). Other turns may use the harness's prediction.
import { controlStep, controlTool, hostOf, latestHandoff, ownDesktopTool } from './agentNarration';
import { toolInvocation } from '../../shared/toolInvocation.mjs';
import { latestBlocked } from './blockedChoices';
import { toolOutput } from './toolOutput';
import { refusalOf } from './controlRefusal';
import type { RefusedApp } from '../../shared/model/store';

type Call = { tool?: unknown; arguments?: unknown };
const argsOf = (item: unknown) => {
  const a = (item as Call | null)?.arguments;
  return (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
};

/** A desktop call's keys ("cmd+n") or menu item ("New Document"), lower-cased; '' for anything else. */
function desktopGesture(name: string, a: Record<string, unknown>): string {
  if (name === 'app_menu' && Array.isArray(a.path)) return `menu:${String(a.path.at(-1) ?? '').toLowerCase()}`;
  const keys = name === 'key' || name === 'app_key' ? (a.combo ?? a.text) : null;
  return typeof keys === 'string' ? `key:${keys.toLowerCase().replace(/\s+/g, '')}` : '';
}
const NEW_DOC = /^(?:key:(?:cmd|command)\+n|menu:new(?: document| file)?(?:\.\.\.|…)?)$/;
const SAVED = /^(?:key:(?:cmd|command)\+(?:shift\+)?s|menu:save\b.*|menu:close\b.*)$/;

/** Whether a browser step failed or its page didn't load (a tool error, or the browser's own net::ERR_ code in the result). */
function pageFailed(item: unknown): boolean {
  const call = item as { status?: unknown; error?: unknown } | null;
  return (
    call?.status === 'failed' || !!call?.error || /\bERR_[A-Z_]+\b|couldn.t load|could not load|failed to load/i.test(toolOutput(item).text)
  );
}

/** The suggested follow-up for a finished turn's items, or null; never one for an app computer use refused in it (`refused`). */
export function suggestNextStep(items: unknown[], refused: RefusedApp[] = [], prediction: string | null = null): string | null {
  items = items.map(toolInvocation);
  const steps = items.filter((i) => controlStep(i));
  if (!steps.length) return refused.length ? null : prediction;
  const handoff = latestHandoff(items)?.handoff;
  if (handoff) return handoff.reason === 'signIn' ? 'Continue after I signed in' : 'Continue, I’m done in the browser';
  const blocked = latestBlocked(items);
  if (blocked?.reason === 'signin_cancelled' || blocked?.reason === 'password_field') return 'Continue after I signed in';
  if (blocked?.reason === 'site_permission_denied') return 'Continue with the sites I allowed';
  // desktop: a new document the turn created and never saved or closed
  let app: string | null = null;
  let unsaved: string | null = null;
  for (const item of steps) {
    const t = ownDesktopTool(item);
    if (!t) {
      // a vendor's desktop tool (Codex's own computer use, the Claude app's): the app its step names
      const vendor = controlStep(item);
      if (vendor?.surface === 'desktop' && vendor.app) app = vendor.app;
      continue;
    }
    const a = argsOf(item);
    if (typeof a.app === 'string' && a.app) app = a.app;
    const g = desktopGesture(t.name, a);
    if (NEW_DOC.test(g)) unsaved = app;
    else if (SAVED.test(g)) unsaved = null;
  }
  // an app computer use refused is not acted on again (#1724)
  if (app && refusalOf(app, refused)) return null;
  if (unsaved) return `Close the new ${unsaved} document without saving`;
  const last = steps.at(-1)!;
  const t = controlTool((last as Call).tool);
  const url = argsOf(last).url;
  // the user took the tab over and the agent could not finish: they say when they are done
  if (t?.surface === 'browser' && /<refusal reason="user_took_over"/.test(toolOutput(last).text))
    return 'Continue, I’m done in the browser';
  if (t?.surface === 'browser' && typeof url === 'string' && url) {
    // an untrusted certificate fails the same way every time: no retry to suggest (the pane offers the user's own browser)
    if (pageFailed(last)) return /\bERR_CERT_[A-Z_]+\b/.test(toolOutput(last).text) ? null : `Try ${hostOf(url)} again`;
    return `Summarize what you found on ${hostOf(url)}`;
  }
  if (app) return `Check ${app} again and tell me what changed`;
  return null;
}

/** Tab, alone, on an empty composer takes the suggestion into the input (the placeholder only shows it). */
export const acceptsNextStep = (
  e: { key: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean },
  text: string,
  suggestion: string | null,
): suggestion is string => e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !text && !!suggestion;
