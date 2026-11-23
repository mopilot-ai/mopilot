// Update and rollback copy names the exact target while keeping installer and safe-restart behavior consistent.
import type { UpdateState } from './native';
import { downloadProgress } from './updateProgress';

export const rollbackAction = (st: UpdateState) =>
  st.available?.rollback ? (st.manual ? 'Download rollback' : 'Restart to roll back') : null;

export function updateDescription(st: UpdateState) {
  switch (st.status) {
    case 'unsupported':
      return 'Updates are only available in release builds.';
    case 'checking':
      return 'Checking for updates…';
    case 'downloading': {
      const version = st.progress?.version ? `version ${st.progress.version}` : 'an update';
      if (st.preparing) return `Preparing ${version}…`;
      const p = downloadProgress(st);
      if (!p) return 'Downloading an update…';
      return `Downloading ${version}… ${p.text}${p.percent === null ? '' : ` (${p.percent}%)`}`;
    }
    case 'ready': {
      const prefix = st.available?.rollback ? `Release ${st.available.rollback.fromVersion} was pulled back. ` : '';
      if (st.manual) return `${prefix}Version ${st.available?.version} is available. Download and run its installer.`;
      if (st.restartWhenIdle) return `${prefix}Version ${st.available?.version} is ready. MoPilot restarts to install it when idle.`;
      return `${prefix}Version ${st.available?.version} is ready. Restart to install it.${st.error ? ` ${st.error}` : ''}`;
    }
    case 'installing':
      return 'Restarting to install the update…';
    case 'error':
      return st.error ?? 'Update check failed.';
    default:
      return st.checkedAt ? `Up to date · checked ${new Date(st.checkedAt).toLocaleTimeString()}` : 'MoPilot';
  }
}
