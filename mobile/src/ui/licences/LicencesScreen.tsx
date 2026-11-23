// The Licences page of Settings › About: who made the code copied into the app and under which licence; a row opens the full notice. Props only, so Settings (R8) links it and a test renders it without a runtime.
import { useState } from 'react';
import { Text } from 'react-native';
import { Group, GroupItem, GroupLabel } from '../../components/Grouped';
import { SheetFrame } from '../../components/SheetFrame';
import { useHardwareBack } from '../../useHardwareBack';
import { useTheme } from '../../theme';
import { typo } from '../../typography';
import { useTranslation } from '../i18n';
import type { LicenceRow } from './licenceRows';

export function LicencesScreen({ rows, back }: { rows: LicenceRow[]; back: () => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [open, setOpen] = useState<LicenceRow | null>(null);
  // one back: from a notice to the list, from the list out
  const up = () => (open ? setOpen(null) : back());
  useHardwareBack(up);
  if (open)
    return (
      <SheetFrame title={open.title} onClose={up} back>
        <GroupLabel>{open.detail}</GroupLabel>
        <Text selectable style={{ ...typo.footnote, color: theme.ink2, paddingHorizontal: 16 }}>
          {open.notice}
        </Text>
      </SheetFrame>
    );
  return (
    <SheetFrame title={t('licences.title')} onClose={up} back>
      {rows.length === 0 ? (
        <Group>
          <GroupItem title={t('licences.none')} />
        </Group>
      ) : (
        <Group>
          {rows.map((r) => (
            <GroupItem key={r.id} title={r.title} value={r.detail} end="chevron" onPress={() => setOpen(r)} />
          ))}
        </Group>
      )}
    </SheetFrame>
  );
}
