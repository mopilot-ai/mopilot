// A failed turn's headline, and the one click that gets past it when there is one: a model the plan doesn't include
// (use the harness's default and retry), or a usage limit (when it resets, and the way on to another harness).
import { toastFailure, useStore } from '../../../store/core';
import { chatHarnessLabel, limitNoteWay } from '../../../store/chats';
import { retryFailedTurn } from '../../../store/failedTurnRetry';
import { currentFamily, firstTierOf } from '../../../harness/family';
import { resetText } from '../../../harness/usageWindows';
import { dispatchComposerCommand } from '../../../lib/shortcutFocus';
import { setSelection, useEffectiveSelection, useHarnessAccounts, useHarnessModels } from '../../../session/harness/select';
import { friendlyError, isBareRateLimit, unavailableModel } from './friendlyError';
import { useChatMachine } from '../../../lib/chatMachine';
import { useMachineAgent } from '../../../session/machineAgent';
import { limitResetNote, otherModel } from './machineModels';
import { setChatConfig } from '../../../store/projects';
import { hostModelSelection } from '../../../../shared/host/models.mjs';
import { activeLogin } from '../../../lib/machinePicker';
import { codeOfText } from '../../../../shared/host/turnErrorCode.mjs';
import { isLoginRefused } from '../../../../shared/loginRefused.mjs';

interface Help {
  text: string;
  note?: string | null;
  action?: { label: string; run: () => unknown } | null;
}

/** What the error box says for `message` in `chatId`, and its action (only for the chat's latest turn: `live`). */
export function useTurnErrorHelp(chatId: string, turnId: string, message: string, live: boolean): Help {
  const h = useStore((s) => firstTierOf(currentFamily(s.segments[chatId], chatId)));
  const models = useHarnessModels(h ?? 'codex');
  const current = useEffectiveSelection(h ?? 'codex', chatId).modelId;
  // a basic harness reports no reset time of its own here
  const own = useHarnessAccounts(h ?? 'codex').active?.limited;
  const limited = h ? own : null;
  const text = friendlyError(message);
  const { machine } = useChatMachine(chatId);
  const there = useMachineAgent(chatId);
  // the provider refused the stored login for its organization: one headline that names the agent and where it runs, and what to do (the sign-in button is the turn's own)
  if (isLoginRefused(message)) {
    const agent = chatHarnessLabel(chatId);
    return {
      text: machine ? `${agent} on ${machine.name} can't run: its login is refused` : `${agent} can't run: its login is refused`,
      note: `The provider does not allow this login to use it. ${machine ? 'Sign in again, or use another machine.' : 'Sign in again.'}`,
    };
  }
  const id = unavailableModel(text);
  if (id !== undefined && machine) {
    // a chat on a machine: that agent's own model list, and the choice is the chat's `hostSelection` there
    const list = there.agent?.models ?? [];
    const named = id ?? hostModelSelection(list, there.saved, machine.id, there.agentId).model?.id ?? null;
    const model = list.find((m) => m.id === named);
    const def = otherModel(list, new Set(named ? [named] : []));
    const agent = there.agent;
    return {
      text: `${model?.name ?? named ?? 'This model'} isn't available on ${machine.name}`,
      action:
        live && def && agent
          ? {
              label: `Use ${def.name}`,
              run: () => {
                setChatConfig(chatId, {
                  hostSelection: { hostId: machine.id, harness: agent.id, model: def.id, effort: def.defaultEffort },
                });
                return retryFailedTurn(chatId, turnId).catch(toastFailure("Couldn't retry"));
              },
            }
          : null,
    };
  }
  if (id !== undefined) {
    const named = id ?? (h ? current : null);
    const model = h ? models.find((m) => m.id === named || m.resolved === named) : undefined;
    const name = model?.label ?? named ?? 'this model';
    // the harness's default, or the first other model when the default is the one refused
    const refused = new Set([named, model?.id].filter(Boolean));
    const def = h ? [models.find((m) => m.isDefault), ...models].find((m) => m && !refused.has(m.id)) : undefined;
    let action: Help['action'] = null;
    if (live && def)
      action = {
        label: `Use ${def.label}`,
        run: () => {
          setSelection(h!, { model: def.id, effort: def.defaultEffort }, chatId);
          return retryFailedTurn(chatId, turnId).catch(toastFailure("Couldn't retry"));
        },
      };
    // a basic harness's models are its own: the picker lists them
    else if (live && !h) action = { label: 'Choose a model', run: () => dispatchComposerCommand('open-model-picker') };
    return { text: `Your plan doesn't include ${name}`, action };
  }
  if (isBareRateLimit(message) || (machine && codeOfText(message) === 'rate_limit')) {
    const way = live ? limitNoteWay(chatId) : null;
    // on a machine: when that machine's login starts over, as it reports it
    const reset = machine
      ? limitResetNote(there.agent && activeLogin(there.agent)?.limitedUntil)
      : limited
        ? resetText({ resetsAt: limited.resetsAt })
        : null;
    return {
      text: machine && !isBareRateLimit(message) ? `Usage limit reached on ${machine.name}` : text,
      note: reset,
      action: way?.action,
    };
  }
  return { text };
}

export function TurnErrorHelp({ chatId, turnId, message, live }: { chatId: string; turnId: string; message: string; live: boolean }) {
  const help = useTurnErrorHelp(chatId, turnId, message, live);
  return (
    <>
      <div>{help.text}</div>
      {help.note && <div className="turn-error-details">{help.note}</div>}
      {help.action && (
        <div className="turn-error-actions">
          <button className="btn-pill primary" onClick={() => void help.action!.run()}>
            {help.action.label}
          </button>
        </div>
      )}
    </>
  );
}
