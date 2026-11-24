// The Settings page: its navigation, the section router, and re-exports of the shared rows the harness pages use.
import { ownTable } from '../../../shared/ownTable.mjs';
import { cancelOnEscape } from '../../lib/focus';
import { HarnessSettings } from './HarnessSettings';
import { HarnessSection, hasOwnHeader } from '../harness/Section';
import { AccountsBilling } from './settings/AccountsBilling';
import { BasicHarnessIcon, HarnessIcon } from '../harnessPicker/HarnessPicker';
import { useHarnessStatus } from '../../session/harness/select';
import { useFreshBasics } from '../../session/harness/acp';
import { installedBasics } from '../../harness/launch';
import { harnessPhase } from '../../harness/accountView';
import {
  Layers,
  Mic,
  MessageCircleDashed,
  AppWindow,
  Search,
  Settings as Gear,
  Sun,
  UserRound,
  Keyboard,
  Archive,
  Info,
  ArrowUpRight,
  ArrowLeft,
  GitBranch,
  Globe,
  MousePointerClick,
  X,
  Plug,
} from '../ui/icons';
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../../store/core';
import { leaveSettings, navigate } from '../../store/panes';
import { PrivacySettings } from './MoPilotSettings';
import { Boxes, Eye, History, MonitorSmartphone, ShieldCheck } from 'lucide-react';
import { OtherHarnesses } from './settings/OtherHarnesses';
import { ComputerUseSettings } from './settings/ComputerUse';
import { ComputerHistorySettings } from './settings/ComputerHistory';
import { ComputerAccessSettings } from './settings/ComputerAccess';
import { isEnabled } from '../../lib/flags';
import { NAV, GROUPS, GROUP_LABEL, resolveSection, splitTab, type SettingsGroup } from '../../lib/settingsNav';
import { highlight, KEYWORDS, searchSettings, tabOfWord } from '../../lib/settingsSearch';
import { withKeys } from '../../lib/listKeys';
import { focusSettingRow } from '../../lib/settingsFocus';
import { General } from './settings/General';
import { Appearance } from './settings/Appearance';
import { Shortcuts } from './settings/Shortcuts';
import { ConnectionsTabs } from './settings/ConnectionsTabs';
import { BuiltinConnectors, QuickActions } from './settings/Integrations';
import { LinearConnection } from './settings/LinearConnection';
import { GitSettings, Worktrees } from './settings/Git';
import { Archived } from './settings/Archived';
import { About } from './settings/About';
import { VoiceSettings } from './settings/Voice';
import { MiniSettings } from './settings/Mini';
import { BrowserSettings } from './settings/Browser';
import { useMomoAllowed } from '../../lib/momo';
import { MomoDot } from '../momo/MomoSidebarRow';

// MoMo's settings load only for an invited account, as its page does
const MomoSettings = lazy(() => import('../momo/settings/MomoSettings'));
/** Settings › MoMo: listed only while MoMo is allowed, and never in SECTIONS (the search palette lists those). */
const MOMO_SECTION: Section = { id: 'momo', label: 'MoMo', group: 'App', icon: <MomoDot size={14} /> };
/** Settings search's words with MoMo's page's, for an account MoMo is allowed for. */
const MOMO_KEYWORDS = {
  ...KEYWORDS,
  momo: ['Brain', 'Routines', 'Proactivity', 'Quiet hours', 'Notify', 'Pause MoMo', 'Reset MoMo', 'Sources'],
};

// Superagent (S1, watch only) lists and loads only while its flag is on
const SuperagentSettings = lazy(() => import('../superagent/SuperagentSettings'));
/** Settings › Superagent: listed only while the flag is on, and never in SECTIONS. */
const SUPERAGENT_SECTION: Section = { id: 'superagent', label: 'Superagent', group: 'App', icon: <Eye size={16} strokeWidth={1.6} /> };
const SUPERAGENT_KEYWORDS = { superagent: ['Repository', 'Allowed people', 'Observe', 'Pause everything', 'GitHub', 'Rules'] };

export { BinPathRow, groupBy, InlineCode, EffortsSelect } from './settings/Rows';
export { ACCENTS } from './settings/Appearance';
export { SHORTCUT_ACTIONS } from './settings/Shortcuts';
export { SshConnections } from './settings/Connections';
export { CodexRuntime } from './settings/About';
export { CloudSettings } from './settings/Cloud';

export { Group, Row, Toggle, Select, Segmented } from './settings/Controls';

export interface Section {
  id: string;
  label: string;
  icon: ReactNode;
  group: SettingsGroup;
  external?: boolean;
  tab?: string;
  section?: string;
}

const I = { size: 16, strokeWidth: 1.6 };
const ICONS: Record<string, ReactNode> = {
  accounts: <UserRound {...I} />,
  general: <Gear {...I} />,
  appearance: <Sun {...I} />,
  mini: <MessageCircleDashed {...I} />,
  shortcuts: <Keyboard {...I} />,
  privacy: <ShieldCheck {...I} />,
  harnesses: <Layers {...I} />,
  codex: <HarnessIcon h="codex" size={16} />,
  claude: <HarnessIcon h="claude" size={16} />,
  'other-harnesses': <Boxes {...I} />,
  computer: <MousePointerClick {...I} />,
  'computer-history': <History {...I} />,
  'computer-access': <MonitorSmartphone {...I} />,
  browser: <AppWindow {...I} />,
  voice: <Mic {...I} />,
  connections: <Globe {...I} />,
  connectors: <Plug {...I} />,
  git: <GitBranch {...I} />,
  archived: <Archive {...I} />,
  about: <Info {...I} />,
};
export const SECTIONS: Section[] = NAV.map((n) => ({ ...n, icon: ICONS[n.id] }));

/** A name with the query's matches marked. */
function Marked({ text, q }: { text: string; q: string }) {
  return (
    <>
      {withKeys(highlight(text, q), (p) => `${p.hit}:${p.text}`).map(({ key, item: p }) =>
        p.hit ? <mark key={key}>{p.text}</mark> : <span key={key}>{p.text}</span>,
      )}
    </>
  );
}

function Nav() {
  const route = useStore((s) => s.route);
  const momo = useMomoAllowed();
  const superagent = isEnabled('superagent');
  const current = route.name === 'settings' ? resolveSection(route.section, route.tab).section : 'general';
  const [q, setQ] = useState('');
  useFreshBasics();
  const basics = useStore((s) => s.basicHarnesses);
  const codex = useHarnessStatus('codex');
  const claude = useHarnessStatus('claude');
  const searching = q.trim() !== '';
  const installed = new Set([
    ...(harnessPhase(codex) !== 'missing' ? ['codex'] : []),
    ...(harnessPhase(claude) !== 'missing' ? ['claude'] : []),
  ]);
  const harnessTab = route.name === 'settings' ? route.tab : undefined;
  // Search keeps setup pages discoverable; the default sidebar lists the harnesses found here.
  const sections = SECTIONS.filter(
    (s) => searching || (s.id !== 'other-harnesses' && (!['codex', 'claude'].includes(s.id) || installed.has(s.id))),
  );
  const basicSections: Section[] = installedBasics(basics).map((b) => ({
    id: `acp:${b.id}`,
    section: 'other-harnesses',
    tab: `harness:${b.id}`,
    label: b.label,
    group: 'Harnesses',
    icon: <BasicHarnessIcon id={b.id} size={16} />,
  }));
  const harnessEnd = sections.findLastIndex((s) => s.group === 'Harnesses') + 1;
  sections.splice(harnessEnd, 0, ...basicSections);
  if (momo) sections.splice(sections.findLastIndex((s) => s.group === 'App') + 1, 0, MOMO_SECTION);
  if (superagent) sections.splice(sections.findLastIndex((s) => s.group === 'App') + 1, 0, SUPERAGENT_SECTION);
  // the remote switch turns computer use off everywhere, its settings too
  const shown = sections.filter((s) => s.id !== 'computer' || isEnabled('shared.computerUse.enabled'));
  // MoMo's words are searchable only while it is listed
  const hits = searchSettings(shown, q, { ...(momo ? MOMO_KEYWORDS : KEYWORDS), ...(superagent ? SUPERAGENT_KEYWORDS : {}) });
  const row = (s: Section, hint: string | null, find: string | null) => (
    <button
      key={s.tab ?? s.id}
      className={`side-row ${current === (s.section ?? s.id) && (!s.tab ? !harnessTab?.startsWith('harness:') : harnessTab === s.tab) ? 'selected' : ''} ${hint ? 'has-hint' : ''}`}
      onClick={() => {
        const tab = s.tab ?? tabOfWord(s.id, find);
        navigate({ name: 'settings', section: s.section ?? s.id, ...(tab ? { tab } : {}), ...(find ? { find } : {}) });
      }}
    >
      <span className="side-row-icon">{s.icon}</span>
      <span className="side-row-label">
        <Marked text={s.label} q={q} />
        {hint && (
          <small className="side-row-hint">
            <Marked text={hint} q={q} />
          </small>
        )}
      </span>
      {s.external && <ArrowUpRight size={14} className="side-row-trailing" />}
    </button>
  );
  return (
    <aside className="sidebar settings-nav">
      {/* pinned above search and the list, so it never scrolls out of view */}
      <div className="sidebar-header settings-back">
        <button className="side-row" onClick={() => leaveSettings()} aria-keyshortcuts="Escape">
          <span className="side-row-icon">
            <ArrowLeft {...I} />
          </span>
          <span className="side-row-label">Back to app</span>
          <kbd className="settings-back-key" aria-hidden="true">
            Esc
          </kbd>
        </button>
      </div>
      <div className="settings-search">
        <Search size={15} strokeWidth={1.7} />
        <input
          placeholder="Search settings"
          aria-label="Search settings"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            // Escape inside an IME composition cancels the composition, not the query
            cancelOnEscape(e, () => setQ(''));
          }}
        />
        {q && (
          <button type="button" className="settings-search-clear" aria-label="Clear search" onClick={() => setQ('')}>
            <X size={11} strokeWidth={2.4} />
          </button>
        )}
      </div>
      <div className="sidebar-scroll">
        {searching ? (
          hits.length ? (
            <div className="sidebar-section">{hits.map((h) => row(h.item, h.hint, h.target))}</div>
          ) : (
            <div className="settings-search-empty">
              No settings match “{q.trim()}”.
              <br />
              Try a word like <i>account</i>, <i>model</i> or <i>browser</i>.
            </div>
          )
        ) : (
          GROUPS.map((g) => {
            const items = shown.filter((s) => s.group === g);
            if (!items.length) return null;
            return (
              <div key={g} className="sidebar-section">
                <div className="side-label">{GROUP_LABEL[g]}</div>
                {items.map((s) => row(s, null, null))}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}

const TITLES: Record<string, string> = ownTable({
  accounts: 'Accounts & billing',
  harnesses: 'All harnesses',
});

export function Settings({ section: rawSection = 'general' }: { section?: string }) {
  const rawTab = useStore((s) => (s.route.name === 'settings' ? s.route.tab : undefined));
  const { section, tab: target } = resolveSection(rawSection, rawTab);
  const { tab } = splitTab(target);
  const route = useStore((s) => s.route);
  const inner = useRef<HTMLDivElement>(null);
  // a search hit lands on its setting, once the page has drawn it; keyed on the route itself, so a second hit with the
  // same word on another page lands too
  useEffect(() => {
    const find = route.name === 'settings' ? route.find : undefined;
    if (!find || !inner.current) return;
    return focusSettingRow(inner.current, find, {
      frame: requestAnimationFrame,
      cancelFrame: cancelAnimationFrame,
      later: (run, ms) => window.setTimeout(run, ms),
      cancelLater: (id) => window.clearTimeout(id),
    });
  }, [route]);
  const s = SECTIONS.find((x) => x.id === section) ?? SECTIONS[0];
  const basics = useStore((s) => s.basicHarnesses);
  const basicId = section === 'other-harnesses' && target?.startsWith('harness:') ? target.slice('harness:'.length) : undefined;
  const basic = basics.find((b) => b.id === basicId);
  // an account MoMo isn't allowed for gets the page an unknown section gets, never MoMo's name
  const momo = useMomoAllowed() && section === 'momo';
  // the same for Superagent while its flag is off
  const superagent = isEnabled('superagent') && section === 'superagent';
  const title = momo ? MOMO_SECTION.label : superagent ? SUPERAGENT_SECTION.label : (basic?.label ?? TITLES[section] ?? s.label);
  return (
    <div className="settings-page">
      <div className="settings-inner" ref={inner}>
        {/* a harness's own page (an installed basic one's too) gives its title in its header */}
        {!hasOwnHeader(section) && !(basic && basic.state !== 'missing') && <h1 className="settings-title">{title}</h1>}
        {section === 'accounts' && <AccountsBilling />}
        {section === 'privacy' && <PrivacySettings />}
        {section === 'general' && <General />}
        {section === 'appearance' && <Appearance />}
        {section === 'shortcuts' && <Shortcuts />}
        {section === 'harnesses' && <HarnessSettings />}
        <HarnessSection section={section} tab={tab} />
        {section === 'other-harnesses' && <OtherHarnesses key={basicId} harnessId={basicId} />}
        {section === 'connections' && (
          <>
            <ConnectionsTabs tab={tab} />
          </>
        )}
        {section === 'connectors' && (
          <>
            <BuiltinConnectors />
            <LinearConnection />
            <QuickActions />
          </>
        )}
        {section === 'git' && (
          <>
            <GitSettings />
            <Worktrees />
          </>
        )}
        {section === 'archived' && <Archived />}
        {section === 'about' && <About />}
        {section === 'voice' && <VoiceSettings />}
        {section === 'mini' && <MiniSettings />}
        {section === 'browser' && <BrowserSettings />}
        {section === 'computer' && <ComputerUseSettings />}
        {section === 'computer-history' && <ComputerHistorySettings />}
        {section === 'computer-access' && <ComputerAccessSettings />}
        {momo && (
          <Suspense fallback={null}>
            <MomoSettings tab={tab} />
          </Suspense>
        )}
        {superagent && (
          <Suspense fallback={null}>
            <SuperagentSettings />
          </Suspense>
        )}
      </div>
    </div>
  );
}
Settings.Nav = Nav;
