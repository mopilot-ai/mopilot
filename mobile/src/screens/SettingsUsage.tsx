// Settings › Usage on the selected Mac: the page's reads, a clock that ages old readings, and the page itself (ui/settings).
import { useEffect, useState } from 'react';
import type { MobileRuntime, MobileSnapshot } from '../contracts';
import { macLink } from '../macLink';
import { useOwnedRequest } from '../remote/useOwnedRequest';
import { useHardwareBack } from '../useHardwareBack';
import { useTranslation } from '../ui/i18n';
import { UsagePage } from '../ui/settings/UsagePage';
import { usageSections } from '../ui/settings/usageModel';
import { useUsagePage } from '../ui/settings/useUsagePage';

export function SettingsUsage({ runtime, state, back }: { runtime: MobileRuntime; state: MobileSnapshot; back: () => void }) {
  useHardwareBack(back);
  // the words are read when the sections are built, so a language change builds them again
  useTranslation();
  const request = useOwnedRequest(runtime);
  const mac = macLink(state);
  const { data, refresh, toggle, pending } = useUsagePage(request, mac.online);
  // readings age and resets come closer while the page is open; the clock changes what is drawn, never what is read
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const sections =
    data.usage || data.accounts ? usageSections({ accounts: data.accounts, usage: data.usage, labels: data.labels, now }) : null;
  return (
    <UsagePage
      sections={sections}
      macName={mac.name}
      online={mac.online}
      busy={data.busy}
      error={data.error}
      switchError={data.switchError}
      oldMac={data.oldMac}
      pending={pending}
      refresh={refresh}
      toggle={toggle}
      back={back}
    />
  );
}
