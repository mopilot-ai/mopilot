// Claude Code's Artifact, ClaudeDesign and DesignSync calls, read from the tool call item: the artifact a publish made (the thread's artifact card), the line each call reads as, and what its approval asks.
import { DESIGN_TOOLS, findClaudeUrl, classifyClaudeUrl, type ClaudeUrlKind } from '../../shared/claudeArtifacts.mjs';
import { nameOf } from './scheduledTaskCall';
import { toolOutput } from './toolOutput';
import { basename } from '../../shared/paths.mjs';

/** A page a call published or changed on claude.ai: what the thread's artifact card shows and opens. */
export interface ArtifactRef {
  url: string;
  /** the link without its query or fragment: one page, however it was linked */
  canonical: string;
  kind: ClaudeUrlKind;
  title: string | null;
  version: string | null;
  action: 'created' | 'updated';
}

type CallItem = {
  type?: string;
  tool?: unknown;
  server?: unknown;
  status?: string;
  error?: unknown;
  result?: { isError?: boolean } | null;
  arguments?: unknown;
};

type Args = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The design tool a call is, with its input; null for any other call (another server's tool of the same name included). */
function designTool(item: unknown): { tool: string; args: Args; it: CallItem } | null {
  const it = item as CallItem | null;
  if (!it || it.type !== 'mcpToolCall') return null;
  const name = nameOf(it);
  // Claude Code's built-in tools have no server; an MCP server's "Artifact" is not this one
  if (!name || name.server || !DESIGN_TOOLS.has(name.tool)) return null;
  const args = it.arguments && typeof it.arguments === 'object' ? (it.arguments as Args) : {};
  return { tool: name.tool, args, it };
}

const finished = (it: CallItem) => it.status === 'completed' && !it.error && it.result?.isError !== true;
const VERSION_RE = /\(version ([^)\s]+)\)/;
/** a typed create whose own files didn't reach it: the page exists but holds none of them, and the result isn't an error */
const FILES_FAILED_RE = /publishing the files to it failed/;
/** ClaudeDesign operations that make or change a project (the rest only read) */
const DESIGN_WRITES: Record<string, ArtifactRef['action']> = { create_project: 'created', write_files: 'updated', copy_files: 'updated' };

/**
 * The page a finished call published or changed: an Artifact publish (not an asset upload) or a ClaudeDesign project
 * write, with the claude.ai link its result names. Claude Code strips the structured result of these calls, so the
 * link, version and whether it was new are read from the result text ("Created a new Artifact at <url> (version 1)…",
 * "Updated the Artifact at <url>…"). Null for anything else, or when the result names no such link.
 */
export function artifactCall(item: unknown): ArtifactRef | null {
  const call = designTool(item);
  if (!call || !finished(call.it)) return null;
  const { tool, args, it } = call;
  const text = toolOutput(it).text;
  let action: ArtifactRef['action'];
  if (tool === 'Artifact') {
    if ((args.action ?? 'publish') !== 'publish' || args.asset === true || FILES_FAILED_RE.test(text)) return null;
    action = /Updated the Artifact at /.test(text) || (!/Created a new Artifact at /.test(text) && !!str(args.url)) ? 'updated' : 'created';
  } else if (tool === 'ClaudeDesign' && typeof args.operation === 'string' && Object.hasOwn(DESIGN_WRITES, args.operation)) {
    action = DESIGN_WRITES[args.operation];
  } else return null;
  const found = findClaudeUrl(text);
  if (!found) return null;
  const title = str(args.title) ?? str((args.arguments as Args | undefined)?.name);
  return { url: found.url, canonical: found.canonical, kind: found.kind, title, version: VERSION_RE.exec(text)?.[1] ?? null, action };
}

/** The claude.ai page a finished Artifact `open` call asked to show (Claude Desktop shows it beside the chat); else null. */
export function artifactOpenRequest(item: unknown): string | null {
  const call = designTool(item);
  if (!call || call.tool !== 'Artifact' || call.args.action !== 'open' || !finished(call.it)) return null;
  const url = str(call.args.url);
  return url && classifyClaudeUrl(url) ? url : null;
}

type Line = { doing: string; done: string; failed: string };
const line = (doing: string, done: string, failed: string): Line => ({ doing, done, failed });
/** Artifact calls by their action, as the user would say what happened */
const ARTIFACT: Record<string, Line> = {
  publish: line('Publishing artifact', 'Published artifact', 'Couldn’t publish artifact'),
  list: line('Listing artifacts', 'Listed artifacts', 'Couldn’t list artifacts'),
  read: line('Reading artifact', 'Read artifact', 'Couldn’t read artifact'),
  quickstart: line('Looking up artifact types', 'Looked up artifact types', 'Couldn’t look up artifact types'),
  upload_asset: line('Uploading to artifact', 'Uploaded to artifact', 'Couldn’t upload to artifact'),
  list_assets: line('Listing artifact files', 'Listed artifact files', 'Couldn’t list artifact files'),
  read_asset: line('Reading artifact file', 'Read artifact file', 'Couldn’t read artifact file'),
  delete_asset: line('Deleting artifact file', 'Deleted artifact file', 'Couldn’t delete artifact file'),
  delete: line('Deleting artifact', 'Deleted artifact', 'Couldn’t delete artifact'),
  open: line('Opening artifact', 'Opened artifact', 'Couldn’t open artifact'),
  pin: line('Pinning artifact', 'Pinned artifact', 'Couldn’t pin artifact'),
  unpin: line('Unpinning artifact', 'Unpinned artifact', 'Couldn’t unpin artifact'),
};
const ARTIFACT_OTHER = line('Working on artifact', 'Worked on artifact', 'Couldn’t work on artifact');
const COMMENTS = line('Checking artifact comments', 'Checked artifact comments', 'Couldn’t check artifact comments');
const DATA = line('Using artifact data', 'Used artifact data', 'Couldn’t use artifact data');

/** "list_projects" as words: "list projects" */
const words = (op: unknown) => (typeof op === 'string' && op ? op.replace(/_/g, ' ') : null);

function lineOf(tool: string, args: Args): Line {
  if (tool === 'Artifact') {
    const action = typeof args.action === 'string' ? args.action : 'publish';
    return Object.hasOwn(ARTIFACT, action) ? ARTIFACT[action] : ARTIFACT_OTHER;
  }
  if (tool === 'ArtifactComments') return COMMENTS;
  if (tool === 'ArtifactData') return DATA;
  const label = tool === 'ClaudeDesign' ? 'Claude Design' : 'Design sync';
  const op = words(args.operation ?? args.method);
  const name = op ? `${label} · ${op}` : label;
  return line(name, name, `${name} failed`);
}

/** The line a design tool call reads as, running or finished ("Published Landing page"); null for any other call. */
export function designCallLine(item: unknown): { text: string; failed: boolean } | null {
  const call = designTool(item);
  if (!call) return null;
  const { it, tool, args } = call;
  const found = lineOf(tool, args);
  const failed =
    it.status === 'failed' ||
    !!it.error ||
    it.result?.isError === true ||
    (found === ARTIFACT.publish && FILES_FAILED_RE.test(toolOutput(it).text));
  if (failed) return { text: found.failed, failed };
  if (it.status !== undefined && it.status !== 'completed') return { text: found.doing, failed };
  const made = found === ARTIFACT.publish ? artifactCall(item) : null;
  return { text: made?.title ? `Published ${made.title}` : found.done, failed };
}

/** What a design tool's approval asks, in words, and the facts it shows in place of the raw input; null for other tools. */
export function designApproval(toolName: unknown, input: unknown): { kind: string; message: string; lines: string[] | null } | null {
  if (typeof toolName !== 'string' || !DESIGN_TOOLS.has(toolName)) return null;
  const args = input && typeof input === 'object' ? (input as Args) : {};
  const url = str(args.url);
  const page = url && classifyClaudeUrl(url) ? url : null;
  if (toolName === 'Artifact') {
    const action = typeof args.action === 'string' ? args.action : 'publish';
    const file = str(args.file_path);
    if (action === 'publish' && args.asset !== true) {
      const title = str(args.title);
      const lines = [
        title && `Title: ${title}`,
        file && `File: ${file}`,
        page ? `Updates: ${page}` : 'Private to you on claude.ai until you share it',
      ];
      return {
        kind: 'Artifact',
        message: page ? 'Update this artifact on claude.ai?' : `Publish ${title ?? (file ? basename(file) : 'this page')} to claude.ai?`,
        lines: lines.filter((l): l is string => !!l),
      };
    }
    if (action === 'delete')
      return { kind: 'Artifact', message: 'Delete this artifact? Its link stops working for everyone.', lines: page ? [page] : null };
    return { kind: 'Artifact', message: `Use artifacts on claude.ai (${action.replace(/_/g, ' ')})?`, lines: null };
  }
  if (toolName === 'ClaudeDesign' || toolName === 'DesignSync') {
    const op = words(args.operation ?? args.method);
    return { kind: 'Claude Design', message: op ? `Run ${op} in Claude Design?` : 'Use Claude Design?', lines: null };
  }
  return { kind: 'Artifact', message: 'Use this artifact on claude.ai?', lines: null };
}
