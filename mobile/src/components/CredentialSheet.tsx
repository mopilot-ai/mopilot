// New chat's sign-in parts for a chat on a machine (the chip, the line naming what it will use, and the sheet): where its model access comes from, only when the machine has more than one source; Automatic leaves it to the machine's own order and says what that is now.
import { BottomSheet } from './BottomSheet';
import { Group, GroupItem } from './Grouped';
import { Text } from 'react-native';
import { Chip } from './Glass';
import { Icon } from './Icon';
import { useStyles } from './ui';
import { useTheme } from '../theme';
import { sourceWords, type credentialChoices } from '../remote/credentialLine';
import type { CredentialSource, MachineAgent } from '../remote/machines';

export function CredentialSheet({
  open,
  close,
  choices,
  source,
  using,
  pick,
}: {
  open: boolean;
  close: () => void;
  choices: ReturnType<typeof credentialChoices>;
  /** the one picked, null: the machine's own order */
  source: CredentialSource | null;
  /** the line naming what the machine's own order uses now (null from a Host that does not say) */
  using: string | null;
  pick: (source: CredentialSource | null) => void;
}) {
  return (
    <BottomSheet open={open} title="Sign-in" onClose={close}>
      <Group>
        <GroupItem
          title="Automatic"
          detail={using ?? undefined}
          end={source === null ? 'check' : 'none'}
          onPress={() => {
            pick(null);
            close();
          }}
        />
        {choices.map((c) => (
          <GroupItem
            key={c.source}
            title={c.label}
            end={c.source === source ? 'check' : 'none'}
            onPress={() => {
              pick(c.source);
              close();
            }}
          />
        ))}
      </Group>
    </BottomSheet>
  );
}

/** The chip that opens the sheet: the pick, or Automatic. */
export function SignInChip({
  source,
  machineName,
  onPress,
}: {
  source: CredentialSource | null;
  machineName: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Chip
      label="Sign-in"
      value={source ? sourceWords(source, machineName) : 'Automatic'}
      icon={<Icon name="lock" glyph="⚿" size={15} color={theme.ink} />}
      onPress={onPress}
    />
  );
}

/** Above the composer, before the first message: what the chat will use, the Host's word, or that this Host cannot say. Nothing for an agent that cannot run there. */
export function CredentialNote({
  agent,
  source,
  using,
  machineName,
}: {
  agent: MachineAgent | undefined;
  source: CredentialSource | null;
  using: string | null;
  machineName: string;
}) {
  const styles = useStyles();
  if (agent?.state !== 'ready') return null;
  return (
    <Text style={styles.muted}>
      {(source ? sourceWords(source, machineName) : using) ?? `Update MoPilot on ${machineName} to see what this chat uses.`}
    </Text>
  );
}
