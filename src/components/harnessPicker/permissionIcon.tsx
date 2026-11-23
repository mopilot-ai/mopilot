// The icon of each permission row (Read-only, Ask for approval, Approve for me, Full access), shared by the composer's
// permission picker and a basic harness's mode picker.
import type { PermissionMode } from '../../store/types';
import { Hand, ShieldAlert, ShieldCheck, ShieldTerminal } from '../ui/icons';

export function permissionIcon(mode: PermissionMode, size = 16) {
  if (mode === 'full-access') return <ShieldAlert size={size} strokeWidth={1.7} />;
  if (mode === 'auto-review') return <ShieldTerminal size={size} />;
  if (mode === 'read-only') return <ShieldCheck size={size} strokeWidth={1.7} />;
  return <Hand size={size} strokeWidth={1.7} />;
}
