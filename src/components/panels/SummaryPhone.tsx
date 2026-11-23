// The session menu's MoPilot phone pairing action, available independently of the chat's harness.
import { openConnectPhone, usePhoneEntry } from '../../lib/phoneEntry';
import { Smartphone } from '../ui/icons';
import { MenuItem } from '../ui/Popover';

export function SummaryPhone() {
  const { available, paired } = usePhoneEntry();
  if (!available) return null;
  return (
    <MenuItem icon={<Smartphone size={15} />} onSelect={openConnectPhone}>
      {paired ? 'Add another phone' : 'Connect your phone'}
    </MenuItem>
  );
}
