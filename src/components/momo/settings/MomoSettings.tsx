// Settings › MoMo (#2139): its Brain (the brain, name and style, proactivity, the background memory pass's limits and use, Pause and Reset, the audit log), Routines and Sources pages, as a harness page's tabs. Settings loads this module only for an account MoMo is allowed for, and it renders nothing once that changes.
import { useMomoAllowed } from '../../../lib/momo';
import { navigate } from '../../../store/panes';
import { Segmented } from '../../pages/settings/Controls';
import { ProactivitySettings } from './Proactivity';
import { BackgroundMemorySettings } from './BackgroundMemory';
import { BrainSettings } from './Brain';
import { NameStyleSettings } from './NameStyle';
import { PauseResetSettings } from './PauseReset';
import { TrustRecordsSettings } from './TrustRecords';
import { RoutinesSettings } from './RoutinesSettings';
import { MomoSourcesSlot } from './SourcesSlot';

const TABS = [
  { value: 'brain', label: 'Brain' },
  { value: 'routines', label: 'Routines' },
  { value: 'sources', label: 'Sources' },
] as const;
type Tab = (typeof TABS)[number]['value'];

export default function MomoSettings({ tab }: { tab?: string }) {
  const allowed = useMomoAllowed();
  if (!allowed) return null;
  const t: Tab = tab === 'sources' || tab === 'routines' ? tab : 'brain';
  return (
    <>
      <div className="settings-tabs">
        <Segmented<Tab> value={t} options={[...TABS]} onChange={(next) => navigate({ name: 'settings', section: 'momo', tab: next })} />
      </div>
      {t === 'brain' && (
        <>
          <BrainSettings />
          <NameStyleSettings />
          <ProactivitySettings />
          <BackgroundMemorySettings />
          <PauseResetSettings />
          <TrustRecordsSettings />
        </>
      )}
      {t === 'routines' && <RoutinesSettings />}
      {t === 'sources' && <MomoSourcesSlot />}
    </>
  );
}
