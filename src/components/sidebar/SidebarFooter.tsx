// The sidebar's foot: the update row, Computer History's status row and the account button with its profile menu (MoPilot credits, harness accounts, settings, help), beside a Report a bug button.
import { useShortcutHint } from '../../session/shortcutHints';
import { profileIdentity } from '../../lib/profileIdentity';
import { useProfileAttention } from '../../session/profileAttention';
import { useStore, toast } from '../../store/core';
import { navigate } from '../../store/panes';
import { openMoPilotPage } from '../../session/open';
import { openBugReport } from '../../lib/bugReportEvent';
import { native } from '../../lib/native';
import { HARNESS_IDS } from '../../harness/types';
import { useMoPilot } from '../../lib/mopilot';
import { hasMoPilotService } from '../../lib/mopilotService';
import { useCreditsView } from '../../harness/useCreditsView';
import { openConnectPhone, usePhoneEntry } from '../../lib/phoneEntry';
import { installedBasics } from '../../harness/launch';
import { useHarnessAccounts } from '../../session/harness/select';
import { profileSummary } from '../../harness/accounts';
import { BasicHarnessMenuRow, HarnessAccountsMenu, avatarColor } from '../accounts/Accounts';
import { Menu, MenuItem, MenuSeparator, MenuLabel, SubMenu, Tooltip, useAnchor } from '../ui/Popover';
import { Settings, Gauge, Keyboard, ExternalLink, MessageCircleDashed, LifeBuoy, Bug, Smartphone } from '../ui/icons';
import { ChevronDown, CircleDollarSign, LogIn } from 'lucide-react';
import { SidebarUpdate } from './SidebarUpdate';
import { SidebarHistory } from './SidebarHistory';
import { focusedChat } from '../../store/split';

export function SidebarFooter() {
  const shortcut = useShortcutHint();
  const miniKey = useStore((s) => s.prefs.miniShortcut);
  const systemUser = useStore((s) => s.systemUsername);
  const basics = installedBasics(useStore((s) => s.basicHarnesses));
  const credits = useCreditsView();
  const phone = usePhoneEntry();
  const attention = useProfileAttention();
  const codex = useHarnessAccounts('codex');
  const claude = useHarnessAccounts('claude');
  // which plans, or how many accounts, the menu holds: the multi-account setup in one line
  const summary = profileSummary([codex, claude]);
  const mp = useMoPilot();
  const identity = profileIdentity(mp, systemUser);
  const profile = useAnchor();
  // a report from the footer is about the chat on screen, as the Help menu's Report a Bug… is (appShortcuts)
  const chatId = useStore(focusedChat);

  return (
    <div className="sidebar-footer">
      <SidebarUpdate />
      <SidebarHistory />
      <div className="account-row">
        <button
          ref={profile.ref}
          type="button"
          className={`side-row account-btn ${profile.open ? 'menu-open' : ''}`}
          onClick={profile.toggle}
          aria-label="Open profile menu"
          aria-haspopup="menu"
          aria-expanded={profile.open}
        >
          <span
            className={`account-avatar ${identity.colorKey ? 'colored' : ''}`}
            style={identity.colorKey ? { background: avatarColor(identity.colorKey) } : undefined}
          >
            {identity.initials}
            {attention && <span className="account-avatar-warn" />}
          </span>
          <span className="account-btn-text">
            <span className="side-row-label">{identity.label}</span>
            {summary && <span className="account-btn-meta">{summary}</span>}
          </span>
          <ChevronDown className="account-chevron" size={14} aria-hidden="true" />
        </button>
        <Tooltip label="Report a bug" placement="top">
          <button type="button" className="icon-btn" aria-label="Report a bug" onClick={() => openBugReport(chatId)}>
            <Bug size={16} strokeWidth={1.7} />
          </button>
        </Tooltip>
      </div>

      <Menu anchor={profile.anchor} open={profile.open} onClose={profile.close} placement="top-start" width={290}>
        <MenuLabel>{identity.label}</MenuLabel>
        {!hasMoPilotService() ? null : credits.signedIn ? (
          <>
            <MenuItem
              dataAccount="mopilot:credits"
              icon={<CircleDollarSign size={15} />}
              description={<span>{credits.email}</span>}
              shortcut={credits.balance}
              onSelect={() => navigate({ name: 'settings', section: 'mopilot' })}
            >
              Credits
            </MenuItem>
            <MenuItem icon={<ExternalLink size={15} />} onSelect={() => openMoPilotPage('/credits')}>
              Buy credits
            </MenuItem>
          </>
        ) : (
          <MenuItem
            icon={<LogIn size={15} />}
            description={credits.signingIn ? <span>Finish in your browser…</span> : undefined}
            onSelect={() =>
              native.mopilot.signIn().then((r) => {
                if (!r.ok && r.error) toast(r.error, 'error');
              })
            }
          >
            Sign in to MoPilot
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuLabel>Harnesses</MenuLabel>
        {HARNESS_IDS.map((h) => (
          <HarnessAccountsMenu key={h} h={h} />
        ))}
        {basics.map((b) => (
          <BasicHarnessMenuRow key={b.id} b={b} />
        ))}
        <MenuSeparator />
        <MenuItem icon={<Gauge size={15} />} onSelect={() => navigate({ name: 'settings', section: 'accounts' })}>
          Accounts & billing
        </MenuItem>
        <MenuItem icon={<MessageCircleDashed size={15} />} shortcut={miniKey ? '⌥Space' : undefined} onSelect={() => native.win.mini()}>
          Open Quick Chat
        </MenuItem>
        {phone.available && (
          <MenuItem icon={<Smartphone size={15} />} onSelect={openConnectPhone}>
            Connect your phone…
          </MenuItem>
        )}
        <MenuItem icon={<Settings size={15} />} shortcut={shortcut('settings')} onSelect={() => navigate({ name: 'settings' })}>
          Settings
        </MenuItem>
        <MenuSeparator />
        <SubMenu icon={<LifeBuoy size={15} />} label="Help">
          <MenuItem icon={<Keyboard size={15} />} onSelect={() => navigate({ name: 'settings', section: 'shortcuts' })}>
            Keyboard shortcuts
          </MenuItem>
          <MenuItem icon={<Bug size={15} />} onSelect={() => openBugReport(chatId)}>
            Report a bug
          </MenuItem>
        </SubMenu>
      </Menu>
    </div>
  );
}
