// The review before a plugin is installed into MoPilot's store: what it brings, and every command and remote
// MCP server it will run on this Mac. Installing names the digest of exactly this list, so a plugin that changed
// since is refused by main (electron/plugins/store.cjs).
import { useEffect } from 'react';
import type { PluginPreview } from '../../lib/native/plugins';
import type { PluginSpec } from '../../../shared/plugins/manifest.mjs';
import { X } from '../ui/icons';
import { FAMILIES, FAMILY_LABEL, reachLine } from './ReachStrip';
import { imeComposing } from '../../lib/focus';
import { includedCounts, pluginTitle } from './pluginView';

type Ready = Extract<PluginPreview, { ok: true }>;

/** whatRuns' bookkeeping (a family's contract, ACP's fixed hook note): nothing that runs, and not part of the trust digest. */
const isBookkeeping = (line: string) => /^\w+: (?:[\w.-]+ \(.*\)|Hooks are not delivered to ACP\.)$/.test(line);

/** Every command and remote address in a configuration, however a harness nests it. */
function collect(value: unknown, out: Set<string>) {
  if (Array.isArray(value)) value.forEach((v) => collect(v, out));
  if (!value || typeof value !== 'object') return;
  const { command, args, url } = value as { command?: unknown; args?: unknown; url?: unknown };
  if (typeof command === 'string') out.add([command, ...(Array.isArray(args) ? args : [])].join(' '));
  if (typeof url === 'string') out.add(url);
  Object.values(value).forEach((v) => collect(v, out));
}

/** What a plugin with per-harness plans actually runs, once each; a manifest's own author or homepage URL isn't that. */
export function commandsOf(spec: PluginSpec): string[] {
  const out = new Set<string>();
  for (const plan of Object.values(spec.execution?.plans ?? {}))
    for (const { component, raw } of plan.sources) {
      if (component !== 'manifest') collect(raw, out);
      else if (raw && typeof raw === 'object') {
        const { hooks, mcpServers, lspServers } = raw as Record<string, unknown>;
        collect([hooks, mcpServers, lspServers], out);
      }
    }
  collect(spec.lspServers, out);
  return [...out];
}

/** `sharedInstall`: where installing also installs into a harness's own app (the Codex mirror), say so. */
export function TrustDialog({
  preview,
  busy,
  sharedInstall,
  onInstall,
  onClose,
}: {
  preview: Ready;
  busy: boolean;
  sharedInstall?: string;
  onInstall: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && !imeComposing(e) && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  const { spec } = preview;
  const config = preview.runs.filter((line) => !isBookkeeping(line));
  // per-harness plans list their sources as raw JSON: the commands first, that list for whoever wants it
  const runs = spec.execution ? commandsOf(spec) : config;
  const title = pluginTitle(spec);
  const counts = includedCounts(spec);
  // every harness getting all of it needs no line; only what differs does
  const lines = FAMILIES.map((f) => ({ f, line: reachLine(spec, f) })).filter(({ line }) => line.state !== 'full');
  return (
    <div className="sketch-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mk-dialog plugin-trust" role="dialog" aria-label={`Install ${title}`}>
        <button type="button" className="mk-close" onClick={onClose} aria-label="Close dialog">
          <X size={16} />
        </button>
        <div className="mk-title">Install {title}?</div>
        {spec.description && <div className="mk-sub">{spec.description}</div>}
        <div className="plugin-trust-section">Includes {counts.length ? counts.join(', ') : 'nothing to run'}.</div>
        <div className="plugin-trust-section">
          {runs.length ? 'Runs on this Mac:' : 'Runs no commands and reaches no remote servers.'}
          {runs.length > 0 && (
            <ul className="plugin-trust-runs">
              {runs.map((r) => (
                <li key={r}>
                  <code>{r}</code>
                </li>
              ))}
            </ul>
          )}
          {spec.execution && config.length > 0 && (
            <details className="plugin-trust-config">
              <summary>Full configuration</summary>
              <ul className="plugin-trust-runs">
                {config.map((r) => (
                  <li key={r}>
                    <code>{r}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
        {Object.keys(spec.lspServers ?? {}).length > 0 && (
          <div className="mk-sub">LSP servers need Claude Code and their language servers.</div>
        )}
        {lines.length > 0 && (
          <div className="plugin-reach">
            {lines.map(({ f, line }) => (
              <div key={f} className={`plugin-reach-row ${line.state}`}>
                <span className="plugin-reach-family">{FAMILY_LABEL[f]}</span>
                <span className="plugin-reach-text">{line.text}</span>
              </div>
            ))}
          </div>
        )}
        {sharedInstall && <div className="mk-sub">{sharedInstall}</div>}
        <div className="mk-foot">
          <button type="button" className="mk-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="mk-btn primary" disabled={busy} onClick={onInstall}>
            {busy ? 'Installing…' : 'Install'}
          </button>
        </div>
      </div>
    </div>
  );
}
