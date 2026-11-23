// Approval stack subscriptions and routing to harness and MoPilot-owned card families.
import { useMemo, type CSSProperties } from 'react';
import { useStore, toastFailure } from '../../store/core';
import { resolveRequest } from '../../store/notifications';
import { interrupt } from '../../store/send';
import { liveAction } from '../../store/liveAction';
import type { PendingRequest } from '../../store/types';
import { ghostCount } from './approvalLogic';
import type { SageApprovalParams } from '../../lib/native';
import { Info } from '../ui/icons';
import { useSession } from '../../store/session/useSession';
import { requestsOf } from '../../harness/approvalRequests';
import { browserUseApproval, nativeAppApproval } from '../../harness/elicitation';
import { chromeTool } from '../../harness/chromeApproval';
import { QuestionCard } from './QuestionCard';
import { agentOfKind, hostFamilyOfHarness } from '../../../shared/host/chatIds.mjs';

import { useSourceLabel, Card, NO_SOURCE } from './approvals/shared';
import { HARNESS_LABEL } from '../../harness/types';
import { SageApprovalCard, DesktopAccessCard, DevServerCard, BrowserPermissionCard } from './approvals/hostCards';
import { CommandApproval, PatchApproval, PermissionsApproval } from './approvals/requestCards';
import { Elicitation, NativeAppApproval } from './approvals/elicitationCards';
import { BrowserUseCard, ChromeToolApproval } from './approvals/browserCards';
import { AcpPermission, ClaudeToolApproval } from './approvals/toolCards';
import { MomoActionCard } from '../momo/MomoActionCard';
import { MomoConnectCard } from '../momo/MomoConnectCard';
import { SessionStartApproval } from './approvals/SessionStartApproval';
import { ConsentApproval } from './approvals/ConsentApproval';
import { HostAskCard } from './approvals/HostAskCard';

/** Cards Sage asks for itself (computer use, browser sites): they live in main's SessionState. */
export function useSageApprovals(threadId: string) {
  const approvals = useSession(threadId).approvals;
  return useMemo(() => approvals.filter((a) => String(a.method).startsWith('sage/')), [approvals]);
}

/** The harness cards of a chat, from main's SessionState: every window shows the same ones (A15). */
export function useHarnessApprovals(threadId: string, cwd: string | null): PendingRequest[] {
  const approvals = useSession(threadId).approvals;
  return useMemo(() => requestsOf(threadId, approvals, cwd, [], 0), [threadId, approvals, cwd]);
}

export function Approvals({ threadId, cwd }: { threadId: string; cwd: string }) {
  const pending = useHarnessApprovals(threadId, cwd);
  const sage = useSageApprovals(threadId);
  // the card takes the composer's place, Stop included: it stays reachable here
  const running = useStore((s) => s.runtime[threadId]?.activeTurnId ?? null);
  const total = pending.length + sage.length;
  if (!total) return null;
  const req = pending[0];
  const sageParams = sage[0]?.params as SageApprovalParams | undefined;
  const desktopCard = sageParams?.kind === 'computerAccessSet' || sageParams?.kind === 'computerTakeover';
  return (
    <div className="approval-stack">
      {ghostCount(total) > 0 && (
        <div className="approval-ghosts" aria-hidden="true">
          {[1, 2].slice(0, ghostCount(total)).map((n) => (
            <span key={`ghost-${n}`} className="approval-ghost" style={{ '--n': n } as CSSProperties} />
          ))}
        </div>
      )}
      {req ? (
        <ApprovalCard key={JSON.stringify([threadId, req.id])} req={req} cwd={cwd} threadId={threadId} more={total - 1} />
      ) : desktopCard ? (
        <DesktopAccessCard key={String(sage[0].id)} threadId={threadId} id={String(sage[0].id)} params={sageParams!} />
      ) : sageParams?.kind === 'devServer' || sageParams?.kind === 'terminalTab' ? (
        <DevServerCard key={String(sage[0].id)} threadId={threadId} id={String(sage[0].id)} params={sageParams} />
      ) : sageParams?.kind === 'momoAction' ? (
        <MomoActionCard key={String(sage[0].id)} id={String(sage[0].id)} params={sageParams.momo!} />
      ) : sageParams?.kind === 'momoConnect' && sageParams.momoConnect ? (
        <MomoConnectCard key={String(sage[0].id)} id={String(sage[0].id)} source={sageParams.momoConnect.source} />
      ) : sageParams?.kind === 'sessionStart' ? (
        <SessionStartApproval key={String(sage[0].id)} threadId={threadId} id={String(sage[0].id)} params={sageParams} />
      ) : sageParams?.kind === 'consent' ? (
        <ConsentApproval key={String(sage[0].id)} threadId={threadId} id={String(sage[0].id)} params={sageParams} />
      ) : sageParams?.kind === 'hostAsk' || sageParams?.kind === 'gatewayTool' ? (
        <HostAskCard key={String(sage[0].id)} id={String(sage[0].id)} params={sageParams} />
      ) : sageParams?.kind === 'browserPermission' ? (
        <BrowserPermissionCard key={String(sage[0].id)} id={String(sage[0].id)} params={sageParams} />
      ) : (
        <SageApprovalCard key={String(sage[0].id)} threadId={threadId} id={String(sage[0].id)} params={sageParams!} />
      )}
      {(total > 1 || running) && (
        <div className="approval-queue">
          {total > 1 && <span>{total - 1} more waiting</span>}
          {running && (
            <button
              type="button"
              className="approval-stop"
              onClick={() => void liveAction(interrupt(threadId, running)).catch(toastFailure("Couldn't stop"))}
            >
              Stop chat
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The agent a chat on a machine runs, when it is Claude Code or Codex: the one its Host said after a switch, else the one its id names (`acp:host-claude:<uuid>`). Its approvals are drawn like This Mac's; a basic agent's keep their own. */
const hostCardFamily = (threadId: string, said: unknown): 'claude' | 'codex' | null => {
  const family = agentOfKind(said) ?? hostFamilyOfHarness(/^acp:([^:]+):/.exec(threadId)?.[1] ?? '');
  return family && ['claude', 'codex'].includes(family) ? (family as 'claude' | 'codex') : null;
};

export function ApprovalCard({ req, cwd, threadId, more }: { req: PendingRequest; cwd: string; threadId: string; more: number }) {
  const sourced = useSourceLabel(threadId, req.params, req.sourceHarness);
  // the agent a machine's Host last said this chat runs on
  const said = useStore((s) => s.chatConfig?.[threadId]?.hostAgent);
  // a card of a chat on a machine whose source names no agent still names the one the chat runs, as This Mac's card does (not "The agent")
  const family = hostCardFamily(threadId, said);
  const agent = sourced === NO_SOURCE && family ? HARNESS_LABEL[family] : sourced;
  // read before the switch: a method this version has no card for is past every case
  const method: string = req.method;
  switch (req.method) {
    case 'item/commandExecution/requestApproval':
    case 'execCommandApproval':
      return <CommandApproval req={req} cwd={cwd} more={more} agent={agent} />;
    case 'item/fileChange/requestApproval':
    case 'applyPatchApproval':
      return <PatchApproval req={req} cwd={cwd} threadId={threadId} more={more} agent={agent} />;
    case 'item/permissions/requestApproval':
      return <PermissionsApproval req={req} more={more} agent={agent} />;
    case 'item/tool/requestUserInput':
      return <QuestionCard req={req} agent={agent} onAnswer={resolveRequest} />;
    case 'claude/toolApproval':
      return chromeTool(req.params.toolName) ? <ChromeToolApproval req={req} /> : <ClaudeToolApproval req={req} cwd={cwd} />;
    case 'acp/permission':
      return <AcpPermission req={req} cwd={cwd} agent={agent} host={family !== null} />;
    case 'mcpServer/elicitation/request': {
      // Codex's own computer use asking to control an app (a native thread only, serverRequests.cjs)
      const app = nativeAppApproval(req.params);
      if (app) return <NativeAppApproval req={req} approval={app} />;
      // Codex's Browser plugin asking for a site, DevTools, history, a file transfer or a WebMCP tool
      const browser = browserUseApproval(req.params);
      return browser ? <BrowserUseCard req={req} approval={browser} agent={agent} /> : <Elicitation req={req} />;
    }
    default:
      return (
        <Card
          req={req}
          icon={<Info size={18} />}
          kind="Request"
          message={`${agent} sent an unsupported request: ${method}`}
          primary={{ label: 'Dismiss', result: { decision: 'cancel' } }}
          deny={{ decision: 'cancel' }}
        />
      );
  }
}
