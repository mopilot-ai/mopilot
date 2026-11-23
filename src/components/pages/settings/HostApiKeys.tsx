// Settings › My machines › How machines sign in › My API keys: one field per provider (KEY_PROVIDERS), a key the person gives once, kept encrypted on this Mac and lent to a machine while a chat of the agent that uses it runs; a saved key shows only its last four characters, with Remove.
import { useEffect, useState } from 'react';
import { toast } from '../../../store/core';
import { native } from '../../../lib/native';
import { userError } from '../../../../shared/userError.mjs';

/** The providers a key can be given for, in the order the sheet lists them; a new provider is one more entry. */
export const KEY_PROVIDERS: readonly { id: string; title: string; hint: string }[] = [
  { id: 'anthropic', title: 'Anthropic key', hint: 'sk-ant-…' },
  { id: 'openai', title: 'OpenAI key', hint: 'sk-…' },
  { id: 'google', title: 'Gemini key', hint: 'AIza…' },
  { id: 'xai', title: 'xAI key', hint: 'xai-…' },
  { id: 'deepseek', title: 'DeepSeek key', hint: 'sk-…' },
];

/** The saved keys' hints by provider, read once; `loaded` once main answered (a failed read is none saved). */
export function useApiKeys() {
  const [hints, setHints] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    native.host.apiKeys().then(
      (h) => live && (setHints(h && typeof h === 'object' ? h : {}), setLoaded(true)),
      (e) => {
        if (live) setLoaded(true);
        toast(userError(e), 'error');
      },
    );
    return () => void (live = false);
  }, []);
  return { hints, setHints, loaded };
}

/** Saves each typed key, telling `onSaved` its hint as each one is kept (so a later refusal leaves the earlier ones shown as saved). Throws the first refusal. */
export async function saveKeys(typed: Record<string, string>, onSaved: (id: string, hint: string) => void): Promise<void> {
  for (const [id, key] of Object.entries(typed)) if (key.trim()) onSaved(id, await native.host.setApiKey(id, key.trim()));
}

export function ApiKeyFields({
  hints,
  typed,
  onType,
  onRemove,
  busy,
}: {
  hints: Record<string, string>;
  typed: Record<string, string>;
  onType: (id: string, value: string) => void;
  onRemove: (id: string) => void;
  busy: boolean;
}) {
  return (
    <div className="signin-fields">
      {KEY_PROVIDERS.map((p) =>
        hints[p.id] ? (
          <div key={p.id} className="signin-saved">
            <span>
              {p.title} · saved ({hints[p.id]})
            </span>
            <button className="link-btn" disabled={busy} onClick={() => onRemove(p.id)} aria-label={`Remove the ${p.title}`}>
              Remove
            </button>
          </div>
        ) : (
          <input
            key={p.id}
            className="text-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={`${p.title}  ${p.hint}`}
            value={typed[p.id] ?? ''}
            onChange={(e) => onType(p.id, e.target.value)}
            aria-label={p.title}
          />
        ),
      )}
    </div>
  );
}
