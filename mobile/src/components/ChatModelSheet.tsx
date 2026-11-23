// The open chat's model pill and what it opens: New chat's Select model sheet (model, effort, permissions) with an Agent row, and the Agent sheet that moves the chat to another agent from its next message. A pick shows at once and is taken back if the Mac refuses it.
import { useEffect, useRef } from 'react';
import { View } from 'react-native';
import type { Owned } from '../remote/client';
import { setChatAccount, setModel, setPermission, switchAgent, type ChatControls } from '../remote/controls';
import { explain } from '../remote/client';
import { harnessChip } from '../presentation/chatChips';
import { withAccount, withAgent, withEffort, withModel, withPermission } from '../remote/pickPatches';
import { optimistic } from '../remote/useChatControls';
import { BottomSheet } from './BottomSheet';
import { ModelPill } from './ComposerBox';
import { Group, GroupItem, GroupLabel } from './Grouped';
import { ModelSheet } from './NewChatSheets';

/** "Opus 5.5" and its effort ("High"), or nothing until the Mac names a model. */
export function pillWords(controls: ChatControls | null): { model: string; detail?: string } | null {
  const o = controls?.options;
  const m = o?.models.find((x) => x.id === o.model);
  // a chat on a machine has no model of this Mac's to name: the pill names its agent, which is what the sheet it opens moves; so does a chat just moved to
  // another agent, whose model the Mac names when the controls are read again
  if (!m || controls?.moved) return (controls?.machine || controls?.moved) && controls.harness ? { model: controls.harness.label } : null;
  return {
    model: m.label,
    detail: m.efforts.find((e) => e.id === o!.effort)?.label,
  };
}

/** Which of the chat's model sheets is open; the chat owns it, so the sheets cover the whole chat while the pill sits in the composer. */
export type ModelSheetOpen = 'model' | 'agent' | null;

/** The pill in the composer's bar: the model and its effort; nothing until the Mac names a model. Quieter while the Mac has not answered a pick. */
export function ChatModelPill({ controls, open }: { controls: ChatControls | null; open: () => void }) {
  const words = pillWords(controls);
  return words ? (
    <View
      style={{
        flexShrink: 1,
        minWidth: 0,
        opacity: controls?.saving ? 0.6 : 1,
      }}
    >
      <ModelPill model={words.model} detail={words.detail} onPress={open} />
    </View>
  ) : null;
}

/** What an agent row says to VoiceOver after its name: why it cannot be chosen, or that it is where the chat is or goes. */
export function agentSaid(
  h: { id: string; unavailable?: boolean; detail?: string | null },
  chosen: string,
  switching: boolean,
): string | undefined {
  if (h.unavailable) return `not available: ${h.detail ?? 'not ready on this machine'}`;
  if (h.id !== chosen) return undefined;
  return switching ? 'the next message continues here' : 'current agent';
}

/** The sheets the pill opens, drawn at the chat's root (an overlay inside the composer would be clipped to it). */
export function ChatModelSheets({
  request,
  chatId,
  controls,
  reload,
  ownHarness,
  failed,
  clear,
  sheet,
  setSheet,
}: {
  sheet: ModelSheetOpen;
  setSheet: (sheet: ModelSheetOpen) => void;
  request: Owned;
  chatId: string;
  /** the chat's controls (useChatControls); null shows no pill */
  controls: ChatControls | null;
  reload: () => void;
  /** the agent the chat list says the chat runs on, so a move that waits can be called off ("Stay on …") */
  ownHarness?: string;
  /** a pick the Mac refused: its words, shown by the chat */
  failed: (message: string) => void;
  /** Takes back the line a pick set when the next one works, if it is still the one showing. */
  clear?: (message: string) => void;
}) {
  // one pick saves at a time: a tap while one is saving waits its turn and shows when it is sent, so the sheet and the Mac end on the last tap
  const saving = useRef(false);
  const waiting = useRef<{ work: () => Promise<unknown>; apply: (c: ChatControls) => ChatControls }[]>([]);
  const said = useRef<string | null>(null);
  // the sheet's line is about the sheet as it was: opening or closing one, or the chat's agent or its held move changing, takes it back
  // as the Mac said them: a pick's own change of either is not the chat changing, and a refusal's line must outlive taking the pick back
  const agentNow = controls?.asRead ? controls.asRead.agent : controls?.harness?.id;
  const heldNow = controls?.asRead ? controls.asRead.held : controls?.switching;
  // biome-ignore lint/correctness/useExhaustiveDependencies: those changes are the trigger
  useEffect(() => {
    if (said.current !== null) clear?.(said.current);
    said.current = null;
  }, [sheet, agentNow, heldNow]);
  if (!controls) return null;
  const { options, methods, harness, harnesses, switching } = controls;
  // a pick shows at once (`apply`) and the Mac's answer settles it: a refusal takes it back in the Mac's words, an acceptance keeps it showing
  // until the controls are read again, which the Mac's answer does not carry (#4986)
  const write = (work: () => Promise<unknown>, apply: (c: ChatControls) => ChatControls) => {
    if (saving.current) return void waiting.current.push({ work, apply });
    saving.current = true;
    const token = optimistic.show(chatId, apply);
    void work()
      .then(() => {
        optimistic.settle(chatId, token, true);
        if (said.current !== null) clear?.(said.current);
        said.current = null;
      })
      .catch((e) => {
        optimistic.settle(chatId, token, false);
        // picks made on top of one the Mac refused were made on a state that did not happen: they are not sent
        waiting.current = [];
        said.current = explain(e);
        failed(said.current);
      })
      .finally(() => {
        saving.current = false;
        // the Mac's answer replaces what the sheet showed, saved or not
        reload();
        const next = waiting.current.shift();
        if (next) write(next.work, next.apply);
      });
  };
  // a pick among the old agent's menus is not sent to the agent the chat was just moved to: those are read again first (a tap meanwhile asks for that read again)
  const writeMenu = (work: () => Promise<unknown>, apply: (c: ChatControls) => ChatControls): void =>
    controls.moved ? reload() : write(work, apply);
  const pick = methods.pick;
  const permit = methods.permit;
  // what this Mac cannot set is left out of the sheet rather than offered and refused
  const shown = {
    ...options,
    models: pick ? options.models : [],
    permissions: permit ? options.permissions : [],
  };
  // the login row is a choice only where the Mac can set it, the agent can hold a chat on its own login now, and there is a login to pick
  const canAccount = methods.account && options.perChat === true && options.accounts.some((a) => !a.signedOut);
  // a chat on a machine knows its own agent from the machine; any other from the chat list
  const own = controls.machine ? (controls.machine.current ?? undefined) : ownHarness;
  const stay = own && harness && own !== harness.id ? own : null;
  const stayLabel = stay ? (harnesses.find((h) => h.id === stay)?.label ?? harnessChip(stay) ?? stay) : '';
  return (
    <>
      <ModelSheet
        open={sheet === 'model'}
        close={() => setSheet(null)}
        options={shown}
        model={options.model}
        effort={options.effort}
        permission={options.permission}
        account={options.account?.id ?? null}
        serving={options.account?.serving}
        pickAccount={canAccount ? (id) => writeMenu(() => setChatAccount(request, chatId, id), withAccount(id)) : undefined}
        agent={methods.agent && harness ? { label: harness.label, open: () => setSheet('agent') } : undefined}
        pickModel={(id) => {
          // an effort the new model does not list is replaced by its own default
          const next = options.models.find((m) => m.id === id);
          const effort = next?.efforts.some((e) => e.id === options.effort) ? options.effort : (next?.defaultEffort ?? null);
          writeMenu(() => setModel(request, pick!, chatId, id, effort), withModel(id, effort));
        }}
        pickEffort={(id) => writeMenu(() => setModel(request, pick!, chatId, options.model!, id), withEffort(id))}
        pickPermission={(id) => writeMenu(() => setPermission(request, permit!, chatId, id), withPermission(id))}
      />
      {harness && (
        <BottomSheet open={sheet === 'agent'} title="Agent" onClose={() => setSheet(null)} onBack={() => setSheet('model')}>
          <Group>
            {harnesses.map((h) => (
              <GroupItem
                key={h.id}
                title={h.label}
                {...(h.unavailable && h.detail ? { detail: h.detail } : {})}
                muted={!!h.unavailable}
                say={agentSaid(h, harness.id, !!switching)}
                end={h.id === harness.id ? 'check' : 'none'}
                onPress={() => {
                  // an agent its machine cannot run now says why, in the machine's words, and moves nothing
                  if (h.unavailable) {
                    said.current = h.detail ?? `${h.label} is not ready on this machine.`;
                    return failed(said.current);
                  }
                  if (h.id !== harness.id) write(() => switchAgent(request, chatId, h.id), withAgent(h, own));
                  setSheet(null);
                }}
              />
            ))}
          </Group>
          {switching && <GroupLabel>{`Next message continues on ${harness.label}`}</GroupLabel>}
          {switching && stay && (
            <Group>
              <GroupItem
                title="Undo"
                say={`stay on ${stayLabel}`}
                tone="link"
                onPress={() => {
                  write(() => switchAgent(request, chatId, stay), withAgent({ id: stay, label: stayLabel }, own));
                  setSheet(null);
                }}
              />
            </Group>
          )}
        </BottomSheet>
      )}
    </>
  );
}
