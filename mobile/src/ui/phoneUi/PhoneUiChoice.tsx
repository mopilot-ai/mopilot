// Settings › About › Phone UI: Classic or New, kept through the flag; the choice applies the next time the app opens, and the row says so.
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Group, GroupItem } from '../../components/Grouped';
import { typo } from '../../typography';
import { useTheme } from '../../theme';
import { useTranslation } from '../i18n';
import { phoneUiChoice, type PhoneUi, type PhoneUiControl } from '../flag';

export function PhoneUiChoice({ control }: { control: PhoneUiControl }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [saved, setSaved] = useState<PhoneUi | null>(null);
  useEffect(() => {
    let live = true;
    void control.override().then((value) => live && setSaved(value));
    return () => {
      live = false;
    };
  }, [control]);
  const { picked, pending } = phoneUiChoice(control.get(), saved);
  const choose = (next: PhoneUi) => {
    const before = saved;
    setSaved(next);
    control.setOverride(next).catch(() => setSaved(before));
  };
  return (
    <View testID="phone-ui-choice">
      <Group>
        <GroupItem
          key="classic"
          title={t('phoneUi.classic')}
          end={picked === 'classic' ? 'check' : 'none'}
          onPress={() => choose('classic')}
        />
        <GroupItem key="v2" title={t('phoneUi.new')} end={picked === 'v2' ? 'check' : 'none'} onPress={() => choose('v2')} />
      </Group>
      {pending && <Text style={{ ...typo.footnote, color: theme.ink2, marginBottom: 16 }}>{t('phoneUi.relaunch')}</Text>}
    </View>
  );
}

/** What About appends to the version: which UI this launch draws. */
export function usePhoneUiMarker(control: PhoneUiControl | undefined): string | undefined {
  const { t } = useTranslation();
  return control ? t(control.get() === 'v2' ? 'phoneUi.markerNew' : 'phoneUi.markerClassic') : undefined;
}
