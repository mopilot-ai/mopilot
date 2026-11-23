// Settings → Browser (BU-06): Codex Browser Use's settings, and one Sites table for every way agents reach a
// browser. Codex's settings and per-site rules live in $CODEX_HOME/browser/config.toml, the file Codex's
// Browser plugin and the ChatGPT app use (electron/capabilities/browser/codexBrowserUse.cjs); values that
// Codex's managed policy fixes show read only. The In-app browser and Your Chrome columns edit MoPilot's
// own site grants, one table per browser (electron/capabilities/browser/origins.cjs, D4). Claude in Chrome
// keeps its site permissions in the Claude extension, which the table links to. Below it, the sites the built-in browser always lets use the
// camera, microphone, location or notifications (BrowserWebPermissions.tsx).
import { useEffect, useRef, useState } from 'react';
import {
  native,
  type BrowserUseDecision,
  type BrowserUsePref,
  type BrowserUseState,
  type SiteBrowser,
  type SiteGrant,
} from '../../../lib/native';
import { saveSitePermission } from '../../../lib/browserPermissions';
import {
  ADD_CHOICES,
  addTarget,
  blockedByCodex,
  CLAUDE_CHROME_PERMISSIONS,
  CODEX_RESOURCES,
  DECISION_LABEL,
  policyRows,
  SITE_BROWSERS,
  siteOrigin,
  siteRows,
  type AddChoice,
  type SiteRow,
} from '../../../lib/browserSites';
import { useChromeLinks } from '../../../session/nativeAvailability';
import { toast } from '../../../store/core';
import { openLink } from '../../../session/open';
import { Group, Row, Select, Toggle } from '../Settings';
import { BrowserWebPermissions } from './BrowserWebPermissions';
import { errorText } from '../../../lib/ignored';

/** A browser's cell for a site Codex blocks: MoPilot's browser tools refuse it too, in every chat (#1319 G13). */
const BLOCKED_BY_CODEX = 'Blocked (Codex)';
const MODE_LABEL: Record<string, string> = { always_ask: 'Always ask', never_ask: 'Auto-approve', disabled: 'Never allow' };

export function BrowserUseSettings() {
  const [codex, setCodex] = useState<BrowserUseState | null>(null);
  const [grants, setGrants] = useState<Partial<Record<SiteBrowser, SiteGrant[]>> | null>(null);
  const [grantsError, setGrantsError] = useState<string | null>(null);
  const grantsRevision = useRef(0);
  useEffect(() => {
    let live = true;
    const revision = grantsRevision.current;
    native.browserUse.state().then(
      (s) => live && setCodex(s),
      (e) => live && setCodex({ file: 'browser/config.toml', error: errorText(e) }),
    );
    // each browser's own table (D4); a table saved meanwhile is newer than what this read
    for (const { id } of SITE_BROWSERS)
      native.browser.sites(id).then(
        (g) => live && revision === grantsRevision.current && setGrants((all) => ({ ...all, [id]: g })),
        (e) => live && revision === grantsRevision.current && setGrantsError(errorText(e)),
      );
    return () => {
      live = false;
    };
  }, []);
  /** A Codex change: the answer is the file as saved; a refusal keeps what is shown. */
  const codexChange = async (p: Promise<BrowserUseState>) => {
    try {
      setCodex(await p);
      return true;
    } catch (e) {
      toast(`Couldn't save the Codex browser setting: ${errorText(e)}`, 'error');
      return false;
    }
  };
  const mopilotChange = (origin: string, level: SiteGrant['level'] | null, browser: SiteBrowser) =>
    saveSitePermission(
      native.browser,
      origin,
      level,
      (sites) => {
        grantsRevision.current++;
        setGrants((all) => ({ ...all, [browser]: sites }));
        setGrantsError(null);
      },
      (m) => toast(m, 'error'),
      browser,
    );
  return (
    <>
      <CodexBrowserUse state={codex} change={codexChange} />
      <Sites codex={codex} grants={grants} grantsError={grantsError} codexChange={codexChange} mopilotChange={mopilotChange} />
      <BrowserWebPermissions />
    </>
  );
}

/** A preference: its control, or what policy fixes it to. */
function Pref({
  state,
  name,
  change,
  label,
}: {
  state: BrowserUseState;
  name: Exclude<BrowserUsePref, 'fullCdp'>;
  change: (p: Promise<BrowserUseState>) => Promise<boolean>;
  label?: string;
}) {
  const p = state.prefs![name];
  if (p.locked)
    return <span className="status-pill" title={p.locked}>{`${label ? `${label}: ` : ''}${MODE_LABEL[String(p.value)]} (managed)`}</span>;
  return (
    <Select
      value={String(p.value)}
      options={p.options.map((v) => ({ value: String(v), label: `${label ? `${label}: ` : ''}${MODE_LABEL[String(v)]}` }))}
      onChange={(v) => change(native.browserUse.setPreference(name, v))}
    />
  );
}

/** Codex Browser Use: how its Browser plugin asks before it uses your Chrome. */
function CodexBrowserUse({ state, change }: { state: BrowserUseState | null; change: (p: Promise<BrowserUseState>) => Promise<boolean> }) {
  if (!state) return null;
  const blocked = state.error
    ? { title: `Couldn't read ${state.file}`, desc: state.error }
    : state.disabled
      ? { title: 'Browser use is off for Codex', desc: state.disabled }
      : null;
  const unknown =
    !blocked && state.requirementsKnown === false ? " Codex isn't running, so its organization policy may be out of date." : '';
  const cdp = state.prefs?.fullCdp;
  return (
    <Group title="Codex Browser Use" desc={`When Codex's Browser plugin asks first.${unknown}`}>
      {blocked ? (
        <Row title={blocked.title} desc={blocked.desc} />
      ) : (
        <>
          <Row title="Site access" desc="When Codex wants a site you haven't saved a permission for">
            <Pref state={state} name="approvalMode" change={change} />
          </Row>
          <Row title="Downloads and uploads" desc="When Codex wants to save or send a file on a site">
            <Pref state={state} name="downloadMode" change={change} label="Downloads" />
            <Pref state={state} name="uploadMode" change={change} label="Uploads" />
          </Row>
          <Row title="Browsing history" desc={state.prefs!.historyMode.locked ?? 'When Codex wants to look through your Chrome history'}>
            <Pref state={state} name="historyMode" change={change} />
          </Row>
          <Row title="Full CDP access" desc={cdp!.locked ?? 'Reads and changes cookies, storage and network traffic.'}>
            <Toggle
              on={cdp!.value === true}
              disabled={!!cdp!.locked}
              onChange={(v) => {
                // turning it on is the elevated-risk step: it asks once more
                if (v && !window.confirm('Allow Codex full DevTools access on sites you allow?')) return;
                return change(native.browserUse.setPreference('fullCdp', v));
              }}
            />
          </Row>
        </>
      )}
    </Group>
  );
}

const decisionOf = (v: string): BrowserUseDecision => (v === 'allow' || v === 'deny' ? v : null);

/** Every saved site, with a column per route; managed policies first, read only. */
function Sites({
  codex,
  grants,
  grantsError,
  codexChange,
  mopilotChange,
}: {
  codex: BrowserUseState | null;
  grants: Partial<Record<SiteBrowser, SiteGrant[]>> | null;
  grantsError: string | null;
  codexChange: (p: Promise<BrowserUseState>) => Promise<boolean>;
  mopilotChange: (origin: string, level: SiteGrant['level'] | null, browser: SiteBrowser) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState('');
  const [choice, setChoice] = useState<AddChoice>('plugin:allow');
  const links = useChromeLinks(true);
  const codexOk = !!codex && !codex.error && !codex.disabled;
  const rows = siteRows(codex, grants);
  const policies = policyRows(codex);
  const permissions = links?.find((l) => l.link?.permissionsUrl)?.link?.permissionsUrl ?? CLAUDE_CHROME_PERMISSIONS;
  const choices = ADD_CHOICES.filter((c) => codexOk || !c.value.startsWith('plugin:'));
  const add = async () => {
    const origin = siteOrigin(draft);
    if (!origin) return toast('Enter a site address, such as example.com', 'error');
    const target = addTarget(choices.some((c) => c.value === choice) ? choice : choices[0].value);
    const saved =
      'codex' in target
        ? await codexChange(native.browserUse.setRule('browse', origin, target.codex))
        : await mopilotChange(origin, target.mopilot, target.browser);
    if (saved) setDraft((current) => (current === draft ? '' : current));
  };
  const remove = async (r: SiteRow) => {
    if (Object.values(r.codex).some(Boolean)) await codexChange(native.browserUse.forget(r.origin));
    for (const { id } of SITE_BROWSERS) if (r.mopilot[id]) await mopilotChange(r.origin, null, id);
  };
  return (
    <Group title="Sites" desc="The built-in browser and your Chrome keep separate permissions.">
      {grantsError && (
        <div className="error-banner" role="alert">
          Couldn't load MoPilot site permissions: {grantsError}
        </div>
      )}
      <div className="sites-table" role="table" aria-label="Sites">
        <div className="sites-row sites-head" role="row">
          <span role="columnheader">Site</span>
          {CODEX_RESOURCES.map((r) => (
            <span key={r.id} role="columnheader" title="Codex Browser Use">
              Codex · {r.label}
            </span>
          ))}
          {SITE_BROWSERS.map((b) => (
            <span key={b.id} role="columnheader" title={b.title}>
              {b.label}
            </span>
          ))}
          <span role="columnheader" aria-label="Actions" />
        </div>
        {policies.map((p) => (
          <div key={`${p.source}:${p.label}`} className="sites-row locked" role="row" data-source={p.source}>
            <span className="sites-origin" role="cell">
              {p.label} <span className="applies-to">{p.source}</span>
            </span>
            {CODEX_RESOURCES.map((r) => (
              <span key={r.id} role="cell" className="sites-fixed">
                {p.codex[r.id] ? DECISION_LABEL[p.codex[r.id]!] : '—'}
              </span>
            ))}
            {SITE_BROWSERS.map((b) => (
              <span key={b.id} role="cell" className="sites-fixed">
                {blockedByCodex(p) ? BLOCKED_BY_CODEX : '—'}
              </span>
            ))}
            <span role="cell" />
          </div>
        ))}
        {rows.map((r) => (
          <div key={r.origin} className="sites-row" role="row">
            <span className="sites-origin" role="cell">
              {r.origin}
            </span>
            {CODEX_RESOURCES.map((res) => (
              <span key={res.id} role="cell">
                <select
                  className="sites-select"
                  aria-label={`Codex ${res.label} for ${r.origin}`}
                  value={r.codex[res.id] ?? ''}
                  disabled={!codexOk}
                  onChange={(e) => codexChange(native.browserUse.setRule(res.id, r.origin, decisionOf(e.target.value)))}
                >
                  <option value="">Ask</option>
                  <option value="allow">Allow</option>
                  <option value="deny">Block</option>
                </select>
              </span>
            ))}
            {SITE_BROWSERS.map((b) =>
              blockedByCodex(r) ? (
                <span key={b.id} role="cell" className="sites-fixed">
                  {BLOCKED_BY_CODEX}
                </span>
              ) : (
                <span key={b.id} role="cell">
                  <select
                    className="sites-select"
                    aria-label={`${b.label} for ${r.origin}`}
                    value={r.mopilot[b.id] ?? ''}
                    onChange={(e) =>
                      mopilotChange(r.origin, e.target.value === 'read' || e.target.value === 'write' ? e.target.value : null, b.id)
                    }
                  >
                    <option value="">Ask</option>
                    <option value="read">Read only</option>
                    <option value="write">Read and write</option>
                  </select>
                </span>
              ),
            )}
            <span role="cell">
              <button className="btn-pill soft" aria-label={`Remove ${r.origin}`} onClick={() => remove(r)}>
                Remove
              </button>
            </span>
          </div>
        ))}
        {!rows.length && !grantsError && <div className="sites-empty">No saved sites yet.</div>}
      </div>
      <form
        className="sites-add"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          className="text-input slim"
          aria-label="Site to add"
          placeholder="example.com"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Select value={choices.some((c) => c.value === choice) ? choice : choices[0].value} options={choices} onChange={setChoice} />
        <button type="submit" className="btn-pill soft" disabled={!draft.trim()}>
          Add
        </button>
      </form>
      <div className="sites-note">
        Claude in Chrome keeps its own site permissions.{' '}
        <button className="btn-link" onClick={() => openLink(permissions)}>
          Manage in Chrome
        </button>
      </div>
    </Group>
  );
}
