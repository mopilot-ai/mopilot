// Shared plugin inventory, family execution plans and manifest projection types.
export type PluginSource = {
  source: string;
  state: 'absent' | 'read' | 'error';
  kind?: 'file' | 'link' | 'other';
  parentKind?: 'directory' | 'other';
  raw?: unknown;
  numberTokens?: Record<string, string>;
  text?: string;
  error?: string;
};
export type PluginExecutionPlan = {
  contract: string;
  layout: string;
  state: 'supported' | 'withheld';
  reasons: string[];
  sources: (PluginSource & { component: string })[];
  ignored: string[];
  unavailable?: { kind: 'hooks'; name: string; why: string }[];
  mcpServers: Record<string, McpServerSpec>;
  hooks: HookSpec[];
  hookEvents: string[];
};
export type PluginExecution = {
  version: number;
  inventory: PluginSource[];
  plans: Record<'claude' | 'codex' | 'acp', PluginExecutionPlan>;
};

/** Where a JSON component is: files inside the plugin and objects given inline in plugin.json; `optional` for the default file. */
export type ComponentSource = { entries: ({ file: string } | { inline: Record<string, unknown> })[]; optional: boolean };

export type PluginManifest = {
  layout: string;
  name: string;
  version?: string;
  description?: string;
  displayName: string;
  category?: string;
  author?: string;
  homepage?: string;
  logo?: string;
  skills: string[];
  commands: string[];
  agents: string[];
  hooks: ComponentSource;
  mcpServers: ComponentSource;
  lspServers: ComponentSource;
  apps: ComponentSource;
  problems: string[];
};

export type MarkdownComponent = { name: string; description?: string; file: string };
export type McpServerSpec =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers: Record<string, string> }
  | { type: 'other'; raw: string };
export type HookSpec = { event: string; matcher?: string; command: string };

/** Everything a plugin carries, read from disk; every harness adapter works from this. */
export type PluginSpec = Omit<
  PluginManifest,
  'skills' | 'commands' | 'agents' | 'hooks' | 'mcpServers' | 'lspServers' | 'apps' | 'problems'
> & {
  root: string;
  execution?: PluginExecution;
  skills: MarkdownComponent[];
  commands: MarkdownComponent[];
  agents: MarkdownComponent[];
  hooks: HookSpec[];
  mcpServers: Record<string, McpServerSpec>;
  /** Complete inert configurations, including fields only the native harness interprets. */
  lspServers?: Record<string, unknown>;
  apps: string[];
  problems: string[];
};

export const MANIFEST_FILES: string[];
export const DEFAULT_DIRS: { skills: string[]; commands: string[]; agents: string[] };
export const DEFAULT_HOOKS: string;
export const DEFAULT_MCP: string;
export const DEFAULT_LSP: string;
export const DEFAULT_APPS: string;
export function isPluginName(name: unknown): name is string;
export function pluginId(name: string, marketplace: string): string;
export function parsePluginId(id: unknown): { name: string; marketplace: string } | null;
export function pluginRelative(p: unknown): string | null;
export function readManifest(text: string, layout: string): { ok: true; manifest: PluginManifest } | { ok: false; error: string };
export function frontMatter(text: string): Record<string, string>;
export function markdownComponent(text: string, fallbackName: string, file: string): MarkdownComponent;
export function expandRoot<T>(s: T, root: string): T;
export function normalizeMcpServers(json: unknown, root: string): { servers: Record<string, McpServerSpec>; problems: string[] };
export function normalizeHooks(json: unknown, root: string): HookSpec[];
export function normalizeApps(json: unknown): string[];
export function whatRuns(spec: Pick<PluginSpec, 'mcpServers' | 'lspServers' | 'hooks' | 'execution'> & { root?: string }): string[];
export function trustConfiguration(
  spec: Partial<Pick<PluginSpec, 'root' | 'name' | 'layout' | 'mcpServers' | 'lspServers' | 'hooks' | 'apps' | 'execution'>>,
): unknown;
