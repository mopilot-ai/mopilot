// The account row at the foot of MoMo's rail: the MoPilot account's avatar and name, or the OS user when signed out, opening Accounts & billing. Harness logins stay in their own menus; the row says nothing about which harness MoMo runs on.
import { avatarColor } from '../../accounts/presentation';
import { profileIdentity } from '../../../lib/profileIdentity';
import { useMoPilot } from '../../../lib/mopilot';
import { navigate } from '../../../store/panes';
import { useStore } from '../../../store/core';
import { SHELL_COPY } from './shellCopy';
import styles from './momoShell.module.css';

export function RailAccount() {
  const systemUser = useStore((s) => s.systemUsername);
  const identity = profileIdentity(useMoPilot(), systemUser);
  return (
    <button
      type="button"
      className={styles.account}
      title={SHELL_COPY.account}
      onClick={() => navigate({ name: 'settings', section: 'accounts' })}
    >
      <span
        className={`account-avatar ${identity.colorKey ? 'colored' : ''}`}
        style={identity.colorKey ? { background: avatarColor(identity.colorKey) } : undefined}
        aria-hidden="true"
      >
        {identity.initials}
      </span>
      <span className={styles.accountName}>{identity.label}</span>
    </button>
  );
}
