// Codex config.toml values, memory and custom-instruction settings.

import { InstructionsEditor } from '../../pages/HarnessSettings';
import { useState } from 'react';
import { useStore, toast } from '../../../store/core';
import { loadConfig } from '../../../store/connection';
import { codexUsable } from '../../../store/chats';
import { codexRequest } from '../../../harness/adapters/codex';
import { errorText } from '../../../lib/ignored';
import { openFile } from '../../../session/open';
import { WebLink } from '../../ui/WebLink';
import { withKeys } from '../../../lib/listKeys';
import { AlertCircle, ChevronRight, ArrowUpRight, Spinner } from '../../ui/icons';
import { Group, Row, Toggle, Select, InlineCode, EffortsSelect } from '../../pages/Settings';
import { LoadFailed } from './settingsShared';

async function writeConfig(keyPath: string, value: unknown) {
  try {
    await codexRequest('config/value/write', { keyPath, value, mergeStrategy: 'replace' });
    await loadConfig();
    toast('Saved to config.toml');
  } catch (e) {
    toast(`Couldn't save: ${errorText(e)}`, 'error');
  }
}

/** Codex's config.toml, split by where it belongs: what shapes answers (models) and what only the codex CLI reads (cli). */
export function Configuration({ part }: { part: 'models' | 'cli' }) {
  const config = useStore((s) => s.config);
  const codexHome = useStore((s) => s.codexHome);
  const warnings = useStore((s) => s.configWarnings);
  const configError = useStore((s) => s.configError);
  if (!config)
    return configError ? (
      // the shared failure line, announced like the page's other failed reads
      <LoadFailed what="read config.toml" error={configError} retry={() => void loadConfig()} />
    ) : (
      <Spinner size={16} />
    );
  if (part === 'cli')
    return (
      <>
        {withKeys(warnings, (w) => JSON.stringify([w.summary, w.details])).map(({ key, item: w }) => (
          <div key={key} className="config-warning">
            <AlertCircle size={15} />
            <span>
              <InlineCode text={w.summary} />
              {w.details && (
                <>
                  <br />
                  <InlineCode text={w.details} />
                </>
              )}
            </span>
          </div>
        ))}
        <div className="config-bar">
          <button className="link-muted" onClick={() => codexHome && openFile(codexHome + '/config.toml')}>
            Open config.toml <ArrowUpRight size={13} />
          </button>
        </div>
      </>
    );
  return (
    <>
      <Group title="Model behavior">
        <Row title="Web search">
          <Select
            value={config.web_search ?? 'cached'}
            options={[
              { value: 'disabled', label: 'Disabled' },
              { value: 'cached', label: 'Cached' },
              { value: 'live', label: 'Live' },
            ]}
            onChange={(v) => writeConfig('web_search', v)}
          />
        </Row>
        <Row title="Output detail">
          <Select
            value={config.model_verbosity ?? 'default'}
            options={[
              { value: 'default', label: 'Model default' },
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
            ]}
            onChange={(v) => writeConfig('model_verbosity', v === 'default' ? null : v)}
          />
        </Row>
        <Row title="Reasoning summary">
          <Select
            value={config.model_reasoning_summary ?? 'auto'}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'concise', label: 'Concise' },
              { value: 'detailed', label: 'Detailed' },
              { value: 'none', label: 'None' },
            ]}
            onChange={(v) => writeConfig('model_reasoning_summary', v)}
          />
        </Row>
        <Row title="Reasoning efforts" desc="Which levels the picker offers; each model has its own.">
          <EffortsSelect />
        </Row>
      </Group>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Personalization                                                     */
/* ------------------------------------------------------------------ */
export function Personalization() {
  const config = useStore((s) => s.config);
  const codexHome = useStore((s) => s.codexHome);
  const [editing, setEditing] = useState(false);
  const memories = !!config?.features?.memories;
  const ok = useStore((s) => codexUsable(s));
  // instructions and rules work from files, so they show whether or not Codex is running
  const files = (
    <>
      <Row title="AGENTS.md" desc="Your instructions for every chat. Project instructions also apply.">
        <button className="btn-pill" onClick={() => setEditing((e) => !e)}>
          {editing ? 'Done' : 'Edit'}
        </button>
      </Row>
      {editing && <InstructionsEditor kind="codex" rows={14} placeholder="e.g. Always run the tests before finishing." />}
      <Row title="Custom rules" desc="Actions allowed without approval." onClick={() => codexHome && openFile(`${codexHome}/rules`)}>
        <ChevronRight size={16} />
      </Row>
    </>
  );
  // without Codex the page says once what needs it (harness/codex/Page.tsx); the files still work
  return (
    <>
      <Group
        title="Memory and instructions"
        desc={
          <>
            Memory stays on this computer. <WebLink href="https://developers.openai.com/codex/memory">Learn more</WebLink>
          </>
        }
      >
        {ok && (
          <>
            <Row title="Use memory" desc="Personalize future chats with memories.">
              <Toggle on={memories} onChange={(v) => writeConfig('features.memories', v)} />
            </Row>
            <Row title="Include tool-assisted chats" desc="Include chats using MCP or web search.">
              <Toggle
                on={!config?.memories?.disable_on_external_context}
                disabled={!memories}
                onChange={(v) => writeConfig('memories.disable_on_external_context', !v)}
              />
            </Row>
          </>
        )}
        {files}
        {ok && (
          <Row title="Delete memories" desc="Delete all Codex memories on this computer">
            <button
              className="btn-pill danger"
              onClick={async () => {
                if (!confirm('Delete all Codex memories? This cannot be undone.')) return;
                try {
                  await codexRequest('memory/reset');
                  toast('Memories deleted');
                } catch (e) {
                  toast(errorText(e), 'error');
                }
              }}
            >
              Delete
            </button>
          </Row>
        )}
      </Group>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */
