// The strip above a machine chat's composer with the chat's attention: what the Host says it waits for, or its machine being offline, in the words of shared/host/attentionLine.mjs and with that line's one action (Resume sends "Continue."). Behind `host.unattended`; an approval has no strip, its card is in the thread.
import { Server } from '../ui/icons';
import { useChatMachine } from '../../lib/chatMachine';
import { useChatAttention } from '../../lib/chatAttention';
import { attentionLine, RESUME_MESSAGE } from '../../../shared/host/attentionLine.mjs';
import { RECONNECT_MS } from '../../../shared/host/machineLine.mjs';
import { sendMessage } from '../../store/send';
import { openSettings } from '../../store/chats';
import { useAuthBoxShown } from '../../session/machineAuthBox';
import { useFlag } from '../../lib/flags';
import { HostAwayStrip } from './HostAwayStrip';

/** A link that missed its answer less than 90 s ago: the machine is not called offline yet, and the message waits for it. */
const reconnecting = (row: { linkDroppedAt?: number } | undefined) =>
  typeof row?.linkDroppedAt === 'number' && Date.now() - row.linkDroppedAt < RECONNECT_MS;

export function HostAttentionStrip({ threadId }: { threadId: string }) {
  const { machine } = useChatMachine(threadId);
  const attention = useChatAttention(threadId);
  const asked = useAuthBoxShown(threadId);
  if (!machine) return null;
  // a machine's own sign-in is asked for once: in the failed turn's box when the latest turn draws one with its sign-in button (a second prompt here would be the same event twice), else here
  if (attention?.kind === 'credential' && asked) return null;
  const line = attentionLine({
    attention,
    machineName: machine.name,
    machine: machine.away ? 'offline' : reconnecting(machine.row) ? 'reconnecting' : 'online',
    client: 'mac',
    pauseMinutes: attention?.pauseMinutes,
  });
  if (!line.strip) return null;
  // a machine that does not answer says what its row says (restarted, disk locked, Remote Login off), not one word for every state
  if (machine.away && line.strip === `${machine.name} is offline`) return <HostAwayStrip threadId={threadId} />;
  const act = () => {
    if (line.action?.kind === 'resume') void sendMessage(threadId, RESUME_MESSAGE);
    // signing in (when no failed turn asks for it) and raising a limit are done in the machine's settings
    else openSettings('connections')();
  };
  return (
    <div className="fa-banner host-away-strip" role="status" aria-label={line.strip}>
      <Server size={16} strokeWidth={1.8} className="fa-icon" aria-hidden="true" />
      <div className="fa-text">
        <div className="fa-title">{line.strip}</div>
      </div>
      {line.action && line.action.kind !== 'wake' && (
        <button type="button" className="btn-pill host-strip-action" onClick={act}>
          {line.action.label}
        </button>
      )}
    </div>
  );
}

/** The machine's line above the composer: with `host.unattended` the attention strip, with its one action; without it the offline strip it replaces. */
export function HostLineStrip({ threadId }: { threadId: string }) {
  return useFlag('host.unattended') ? <HostAttentionStrip threadId={threadId} /> : <HostAwayStrip threadId={threadId} />;
}
