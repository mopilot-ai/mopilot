// Command, patch and permission request cards for the shared harness approval vocabulary.
import { useMemo } from 'react';
import { useStore } from '../../../store/core';
import type { PendingRequest, ThreadItem } from '../../../store/types';
import { prettyCommand } from '../../../lib/format';
import { relPath } from '../../../lib/paths';
import { InlineDiff, fileChangeToDiff } from '../../diff/DiffView';
import { Globe, FolderLock, SquareTerminal, Pencil } from '../../ui/icons';
import type { NetworkApprovalContext } from '../../../protocol/v2/NetworkApprovalContext';
import type { RequestPermissionProfile } from '../../../protocol/v2/RequestPermissionProfile';
import { LEGACY_DENY, sandboxEntryLine } from '../approvalLogic';
import { Card, type Choice } from './shared';
/** The command card's reading of every command request: Codex v2 and legacy, and Claude's Bash. */
type CommandView = {
  reason?: string | null;
  networkApprovalContext?: NetworkApprovalContext | null;
  proposedExecpolicyAmendment?: string[] | null;
  kind?: string;
  cwd?: string | null;
};

export function CommandApproval({
  req,
  cwd,
  agent,
}: {
  req: PendingRequest<'item/commandExecution/requestApproval' | 'execCommandApproval'>;
  cwd: string;
  more: number;
  agent: string;
}) {
  const p: CommandView = req.params;
  const legacy = req.method === 'execCommandApproval';
  // a legacy request's command is its argv; a v2 (or Claude) one's is the command line
  const cmd = req.method === 'execCommandApproval' ? (req.params.command ?? []).join(' ') : prettyCommand(req.params.command ?? '');
  const net = p.networkApprovalContext;
  const amend = p.proposedExecpolicyAmendment;
  const message =
    p.reason ||
    (net
      ? `Allow ${agent} to access ${net.host}?`
      : p.kind === 'writeStdin'
        ? `Allow ${agent} to send input to this process?`
        : `Allow ${agent} to run this command?`);
  if (legacy)
    return (
      <Card
        req={req}
        icon={<SquareTerminal size={18} strokeWidth={1.6} />}
        kind="Terminal"
        message={message}
        primary={{ label: 'Allow once', result: { decision: 'approved' } }}
        more={[{ label: 'Allow for this session', result: { decision: 'approved_for_session' } }]}
        deny={LEGACY_DENY}
      >
        <div className="approval-cmd">{cmd}</div>
      </Card>
    );
  const more: Choice[] = [];
  if (amend?.length)
    more.push({
      label: 'Allow similar commands',
      hint: `Don't ask again for commands that start with ${prettyCommand(amend.join(' ').replace(/^(\/bin\/)?(ba|z)?sh -l?c /, ''))}`,
      result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: amend } } },
    });
  else more.push({ label: 'Allow for this session', result: { decision: 'acceptForSession' } });
  return (
    <Card
      req={req}
      icon={net ? <Globe size={18} strokeWidth={1.6} /> : <SquareTerminal size={18} strokeWidth={1.6} />}
      kind={net ? 'Network' : 'Terminal'}
      message={message}
      primary={{ label: 'Allow once', result: { decision: 'accept' } }}
      more={more}
      deny={{ decision: 'decline' }}
    >
      {cmd && <div className="approval-cmd">{cmd}</div>}
      {p.cwd && p.cwd !== cwd && <div className="approval-cwd">in {p.cwd}</div>}
    </Card>
  );
}

/** A legacy patch's change to one file, as the edit card reads it. */
type LegacyFileChangeView = { type?: string; unified_diff?: string; content?: string };
/** The edit card's reading of every edit request: Codex v2 (and Claude's, by item) and legacy (by its file changes). */
type PatchView = {
  itemId?: string | null;
  reason?: string | null;
  grantRoot?: string | null;
  fileChanges?: { [path: string]: LegacyFileChangeView | undefined };
};

export function PatchApproval({
  req,
  cwd,
  threadId,
  agent,
}: {
  req: PendingRequest<'item/fileChange/requestApproval' | 'applyPatchApproval'>;
  cwd: string;
  threadId: string;
  more: number;
  agent: string;
}) {
  const p: PatchView = req.params;
  const legacy = req.method === 'applyPatchApproval';
  const item = useStore((s) => {
    const rt = s.runtime[threadId];
    for (const t of rt?.turns ?? [])
      for (const it of t.items) if (it.id === p.itemId) return it as Extract<ThreadItem, { type: 'fileChange' }>;
    return null;
  });
  const files = useMemo(() => {
    if (legacy && p.fileChanges)
      return Object.entries(p.fileChanges).map(([path, ch]) =>
        fileChangeToDiff({ path, kind: { type: ch?.type ?? 'update' }, diff: ch?.unified_diff ?? ch?.content ?? '' }),
      );
    return (item?.changes ?? []).map(fileChangeToDiff);
  }, [item, p, legacy]);
  const message =
    p.reason ||
    (p.grantRoot
      ? `Allow ${agent} to write to ${p.grantRoot}?`
      : `Allow ${agent} to edit ${files.length === 1 ? relPath(files[0].path, cwd) : `${files.length} files`}?`);
  return (
    <Card
      req={req}
      icon={<Pencil size={18} strokeWidth={1.6} />}
      kind="Edit"
      message={message}
      primary={{ label: 'Allow once', result: { decision: legacy ? 'approved' : 'accept' } }}
      more={[{ label: 'Allow for this session', result: { decision: legacy ? 'approved_for_session' : 'acceptForSession' } }]}
      deny={legacy ? LEGACY_DENY : { decision: 'decline' }}
    >
      <div className="approval-diffs">
        {files.map((f) => (
          <InlineDiff key={f.path} file={f} cwd={cwd} maxHeight={220} />
        ))}
      </div>
    </Card>
  );
}

export function PermissionsApproval({
  req,
  agent,
}: {
  req: PendingRequest<'item/permissions/requestApproval'>;
  more: number;
  agent: string;
}) {
  const p = req.params;
  const perms: Partial<RequestPermissionProfile> = p.permissions ?? {};
  const lines: string[] = [];
  if (perms.network?.enabled) lines.push('Network access');
  for (const r of perms.fileSystem?.read ?? []) lines.push(`Read ${r}`);
  for (const w of perms.fileSystem?.write ?? []) lines.push(`Write ${w}`);
  for (const e of perms.fileSystem?.entries ?? []) lines.push(sandboxEntryLine(e));
  return (
    <Card
      req={req}
      icon={<FolderLock size={18} strokeWidth={1.6} />}
      kind="Permissions"
      message={p.reason || `${agent} is requesting additional permissions`}
      primary={{ label: 'Allow for this turn', result: { permissions: perms, scope: 'turn' } }}
      more={[{ label: 'Allow for this session', result: { permissions: perms, scope: 'session' } }]}
      deny={{ permissions: {}, scope: 'turn' }}
    >
      <div className="approval-cmd">{lines.join('\n')}</div>
    </Card>
  );
}
