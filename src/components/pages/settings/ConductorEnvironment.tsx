// Settings → Git → a project whose environment comes from Conductor's files: what is in use, and converting it to environment.toml.

import { useState } from 'react';
import { Group } from './Controls';
import { ChevronLeft } from '../../ui/icons';
import { abbreviateHome } from '../../../lib/paths';
import { errorText } from '../../../lib/ignored';
import { toast } from '../../../store/core';
import { convertEnvironment, envPath, type ResolvedEnvironment } from '../../../lib/environments';

/**
 * A project with no environment.toml that MoPilot sets up from Conductor's config, read where it is on every worktree
 * start. Nothing here edits Conductor's files; "Convert to environment.toml" writes MoPilot's own file from them, which
 * then takes over. The caller reads the project again after every attempt (`onConverted`).
 */
export function ConductorEnvironment({
  root,
  name,
  resolved,
  onBack,
  onConverted,
}: {
  root: string;
  name: string;
  resolved: ResolvedEnvironment;
  onBack: () => void;
  onConverted: () => void;
}) {
  const [converting, setConverting] = useState(false);
  const files = resolved.files.map(abbreviateHome).join(', ');
  return (
    <>
      <div className="env-head">
        <button className="link-muted" onClick={onBack}>
          <ChevronLeft size={14} /> Environments
        </button>
        <button
          className="btn-white"
          disabled={converting || !!resolved.notice}
          onClick={async () => {
            setConverting(true);
            try {
              await convertEnvironment(root);
              toast(`Converted to ${abbreviateHome(envPath(root))}`);
            } catch (e) {
              toast(errorText(e), 'error');
            } finally {
              setConverting(false);
            }
            // read the project again either way: a refusal may mean its environment.toml appeared meanwhile
            onConverted();
          }}
        >
          Convert to environment.toml
        </button>
      </div>
      {resolved.notice && (
        <div className="config-warning" role="alert">
          {resolved.notice}
        </div>
      )}
      <section className="settings-group">
        <h2 className="settings-group-title">{name}</h2>
        <div className="settings-group-desc">
          This project has no environment.toml, so its Conductor config is used as it is. Edit it in Conductor's files, or convert it to
          edit it here.
        </div>
        <div className="settings-group-desc settings-path" data-env-source>
          Source: {resolved.source === 'conductor' ? 'Conductor settings' : 'Conductor (legacy conductor.json)'}
          {files && `: ${files}`}
        </div>
      </section>
      <section className="settings-group">
        <h2 className="settings-group-title">Setup script</h2>
        <div className="settings-group-desc">Runs in each new worktree before the agent starts working</div>
        <textarea className="text-area settings-textarea mono" rows={5} readOnly value={resolved.setup} />
      </section>
      <section className="settings-group">
        <h2 className="settings-group-title">Cleanup script</h2>
        <div className="settings-group-desc">Runs before a worktree is removed</div>
        <textarea className="text-area settings-textarea mono" rows={3} readOnly value={resolved.cleanup} />
      </section>
      <Group title="Actions" desc="Commands you can run from a chat’s menu; they open in a terminal tab">
        {resolved.actions.length === 0 && <div className="connections-empty">No actions</div>}
        {resolved.actions.map((a) => (
          <div key={a.name} className="env-action" data-env-action={a.name}>
            <span>{a.name}</span>
            <span className="settings-path mono">{a.command}</span>
          </div>
        ))}
      </Group>
    </>
  );
}
