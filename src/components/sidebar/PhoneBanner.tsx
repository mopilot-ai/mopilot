// The sidebar's offer to connect a phone: for an account with Mobile Remote, until a phone is paired or the banner is dismissed.
import { useState } from 'react';
import { Smartphone } from '../ui/icons';
import { dismissPhoneBanner, openConnectPhone, phoneBannerDismissed, usePhoneEntry } from '../../lib/phoneEntry';
import { SideBanner } from './SideBanner';

export function PhoneBanner() {
  const { available, paired } = usePhoneEntry();
  const [dismissed, setDismissed] = useState(phoneBannerDismissed);
  if (!available || paired > 0 || dismissed) return null;
  return (
    <SideBanner
      tone="ask"
      icon={<Smartphone size={16} />}
      title="Connect your phone"
      detail="Keep chatting from your iPhone."
      testId="phone-banner"
    >
      <button
        className="btn sm"
        onClick={() => {
          dismissPhoneBanner();
          setDismissed(true);
        }}
      >
        Later
      </button>
      <button className="btn primary sm" onClick={openConnectPhone}>
        Connect
      </button>
    </SideBanner>
  );
}
