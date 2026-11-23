// ACP permission requests and Claude tool/plan approval cards.
import type { PendingRequest } from '../../../store/types';
import { prettyCommand } from '../../../lib/format';
import { InlineDiff, fileChangeToDiff, type DiffFile } from '../../diff/DiffView';
import { Globe, SquareTerminal, Pencil, Plug, ListChecks, Palette } from '../../ui/icons';
import { designApproval } from '../../../lib/designToolCall';
import { permissionChoices, toolItem } from '../../../harness/acpTranslate';
import type { AcpToolCall } from '../../../harness/requestParams';
import { relPath } from '../../../lib/paths';
import { Card } from './shared';
/**
 * A basic harness's session/request_permission, with its own options as the buttons. `host`: the chat is Claude Code or Codex on a machine, whose
 * approval says what This Mac's card says for the same tool (audit turn:T10): the Host sends the tool call, the words are the same.
 */
export function AcpPermission({
  req,
  cwd,
  agent,
  host = false,
}: {
  req: PendingRequest<'acp/permission'>;
  cwd: string;
  agent: string;
  host?: boolean;
}) {
  const tc: AcpToolCall = req.params.toolCall ?? {};
  const { primary, more, deny } = permissionChoices(req.params.options);
  const item = toolItem({ ...tc, toolCallId: tc.toolCallId ?? String(req.id) }, cwd);
  const files = item.type === 'fileChange' ? item.changes.map(fileChangeToDiff) : [];
  const command = item.type === 'commandExecution' && tc.kind === 'execute' ? prettyCommand(item.command) : null;
  const web = item.type === 'webSearch';
  const icon = files.length ? (
    <Pencil size={18} strokeWidth={1.6} />
  ) : command ? (
    <SquareTerminal size={18} strokeWidth={1.6} />
  ) : web ? (
    <Globe size={18} strokeWidth={1.6} />
  ) : (
    <Plug size={18} strokeWidth={1.6} />
  );
  const kind = files.length ? 'Edit' : command ? 'Terminal' : web ? 'Network' : 'Tool';
  const generic = tc.title ? `${agent} wants to: ${tc.title}` : `${agent} is asking for permission`;
  const fetched = tc.kind === 'fetch' ? (tc.rawInput as { url?: unknown } | undefined)?.url : null;
  const url = typeof fetched === 'string' ? fetched : null;
  const plan = tc.kind === 'switch_mode';
  // the option that allows this call once, whatever the Host calls it (its words are the Host's; This Mac's card says "Allow once")
  const allowOnceId = req.params.options?.find((o: { kind?: string }) => o.kind === 'allow_once')?.optionId;
  const said = !host
    ? null
    : plan
      ? { kind: 'Plan', message: 'Ready to start on this plan?', icon: <ListChecks size={18} strokeWidth={1.6} /> }
      : files.length
        ? { message: `Allow ${agent} to edit ${files.length === 1 ? relPath(files[0].path, cwd) : `${files.length} files`}?` }
        : command
          ? { message: `Allow ${agent} to run this command?` }
          : url
            ? { kind: 'Network', message: `Allow ${agent} to fetch ${url}?`, icon: <Globe size={18} strokeWidth={1.6} /> }
            : null;
  return (
    <Card
      req={req}
      icon={said?.icon ?? icon}
      kind={said?.kind ?? kind}
      message={said?.message ?? generic}
      primary={host && !plan && primary.result.optionId === allowOnceId ? { ...primary, label: 'Allow once' } : primary}
      more={more}
      deny={deny}
    >
      {command && <div className="approval-cmd">{command}</div>}
      {files.length > 0 && (
        <div className="approval-diffs">
          {files.map((f: DiffFile) => (
            <InlineDiff key={f.path} file={f} cwd={cwd} maxHeight={220} />
          ))}
        </div>
      )}
      {!command && !files.length && !!tc.rawInput && (
        <div className="approval-cmd">{JSON.stringify(tc.rawInput, null, 2).slice(0, 4000)}</div>
      )}
    </Card>
  );
}

/** Claude Code tools without a Codex equivalent (WebFetch, MCP tools, ExitPlanMode, …). */
export function ClaudeToolApproval({ req }: { req: PendingRequest<'claude/toolApproval'>; cwd: string }) {
  const p = req.params;
  // the plan and its file are the plan card above (one copy); this card only asks
  if (p.toolName === 'ExitPlanMode')
    return (
      <Card
        req={req}
        icon={<ListChecks size={18} strokeWidth={1.6} />}
        kind="Plan"
        message="Ready to start on this plan?"
        primary={{ label: 'Approve plan', result: { decision: 'accept' } }}
        deny={{ decision: 'decline' }}
      />
    );
  const mcp = String(p.toolName).startsWith('mcp__') ? String(p.toolName).split('__') : null;
  const name = mcp ? `${mcp[1]} · ${mcp.slice(2).join('__')}` : p.toolName;
  const url = p.toolName === 'WebFetch' ? p.input?.url : null;
  // a claude.ai artifact or Claude Design call says what it publishes or changes, not its raw input
  const design = designApproval(p.toolName, p.input);
  return (
    <Card
      req={req}
      icon={
        url ? (
          <Globe size={18} strokeWidth={1.6} />
        ) : design ? (
          <Palette size={18} strokeWidth={1.6} />
        ) : (
          <Plug size={18} strokeWidth={1.6} />
        )
      }
      kind={url ? 'Network' : (design?.kind ?? 'Tool')}
      message={
        p.title || p.reason || (url ? `Allow Claude Code to fetch ${url}?` : (design?.message ?? `Allow Claude Code to use ${name}?`))
      }
      primary={{ label: 'Allow once', result: { decision: 'accept' } }}
      more={[{ label: 'Allow for this session', result: { decision: 'acceptForSession' } }]}
      deny={{ decision: 'decline' }}
    >
      {design?.lines ? (
        <ul className="approval-facts">
          {design.lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : (
        !url && <div className="approval-cmd">{JSON.stringify(p.input ?? {}, null, 2).slice(0, 4000)}</div>
      )}
      {p.blockedPath && <div className="approval-cwd">needs access to {p.blockedPath}</div>}
    </Card>
  );
}
