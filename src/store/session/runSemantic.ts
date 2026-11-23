// Run a semantic (goal, compact, rename, …) on a chat. Components say what they want; which harness
// does it, and how, is decided here from what main says the chat's binding is: a binding that is not
// native or sage-provided is refused with its Why, and the harness's own steps live in
// src/harness/adapters/semantics.ts (the one place besides main that names harnesses).
import type { HarnessKind, Semantic, Why } from '../../harness/adapter';
import { whyText } from '../../harness/caps';
import { harnessInfo } from '../../harness/registry';
import { handlerFor } from '../../harness/adapters/semantics';
import { chatProxy } from '../../harness/adapters/proxy';
import type { CapView, CapsHint } from './capsTypes';
import { capsOf } from './useCaps';

export type SemanticResult =
  | { ok: true; value?: unknown }
  /** the chat can't do it: how it is presented (disabled or absent) and the reason */
  | { ok: false; state: CapView['state']; why: Why | null; kind?: HarnessKind };

/** Fill a passthrough template: {args} with the arguments, and the line trimmed. */
export function fillTemplate(template: string, args: string): string {
  return template
    .replace(/\{args\}/g, () => args)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param chatId the chat the semantic runs on
 * @param semantic what to do
 * @param args the user's arguments ('pause', a goal's condition, a new name, …)
 * @param hint what this window knows that main doesn't yet
 */
export async function runSemantic(chatId: string, semantic: Semantic, args = '', hint?: CapsHint): Promise<SemanticResult> {
  const c = await capsOf(chatId, hint);
  const cap = c?.caps[semantic];
  if (!c || !cap || (cap.state !== 'native' && cap.state !== 'sage'))
    return { ok: false, state: cap?.state ?? 'absent', why: cap?.why ?? null, ...(c ? { kind: c.kind } : {}) };
  if (semantic === 'compact')
    return {
      ok: true,
      value: await chatProxy.send(chatId, `/compact${args ? ` ${args}` : ''}`, [], {
        human: true,
        retainInMain: true,
        compact: { args },
      }),
    };
  const handler = await handlerFor(c.kind, semantic);
  if (handler) return { ok: true, value: await handler({ chatId, args, cap }) };
  // a harness-native command goes through as the harness's own text
  if (cap.via === 'passthrough' && cap.template) {
    const text = fillTemplate(cap.template, args);
    return { ok: true, value: await chatProxy.send(chatId, text, [], { human: true }) };
  }
  return { ok: false, state: 'absent', why: { layer: 'harness', code: 'harness.undeclared' }, kind: c.kind };
}

/** What to tell the user when a semantic was refused: the Why, in the copy table's words. */
export function refusalText(r: Extract<SemanticResult, { ok: false }>, semantic: Semantic): string {
  const info = r.kind ? harnessInfo(r.kind) : null;
  return whyText(r.why ?? { layer: 'harness', code: 'harness.undeclared' }, { label: info?.label, semantic, account: info?.subscription });
}
