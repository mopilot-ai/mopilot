// The / and @ menus above a chat's message box, and the skills the next message carries.
import { FlatList, Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import type { Command, Mention } from '../remote/composerMenu';
import type { Menu } from '../remote/useComposerMenu';
import { Button, ErrorLine, useStyles } from './ui';
import { Enter } from './Motion';
/** Native flex layout shrinks the list into the actual space above the composer and keyboard. */
const shrink = { flexShrink: 1, minHeight: 0 } as const;

/** What a screen reader says for a row, which the visible name and detail alone do not. */
const labelOf = (row: Command | Mention) =>
  'as' in row
    ? `${row.skill ? 'Skill' : 'Command'} /${row.name}${row.description ? `, ${row.description}` : ''}`
    : row.kind === 'chat'
      ? `Chat ${row.title}`
      : `${row.directory ? 'Folder' : 'File'} ${row.path}`;

export function ComposerMenu({
  menu,
  skills,
  pick,
  removeSkill,
}: {
  menu: Menu | null;
  skills: string[];
  pick: (row: Command | Mention) => void;
  removeSkill: (name: string) => void;
}) {
  const styles = useStyles();
  const rows: (Command | Mention)[] = menu?.rows ?? [];
  return (
    <View style={[{ gap: 8 }, shrink]}>
      {skills.length > 0 && (
        <View style={[styles.row, { flexShrink: 0 }]}>
          {skills.map((name) => (
            <Button secondary key={name} title={`/${name} ×`} label={`Remove skill ${name}`} onPress={() => removeSkill(name)} />
          ))}
        </View>
      )}
      {menu && (
        <Enter style={shrink}>
          <View
            accessibilityRole="menu"
            accessibilityLabel={menu.kind === 'slash' ? 'Commands' : 'Chats and files'}
            style={[{ gap: 6 }, shrink]}
          >
            <ErrorLine text={menu.error} />
            {menu.status !== 'error' && !rows.length && (
              <Text accessibilityLiveRegion="polite" style={styles.muted}>
                {menu.status === 'loading' ? 'Loading…' : menu.kind === 'slash' ? 'No commands here.' : 'No chats or files match.'}
              </Text>
            )}
            <FlatList
              data={rows}
              style={{ maxHeight: 260, flexGrow: 0, ...shrink }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator
              keyExtractor={(row) => ('as' in row ? `command:${row.name}` : row.kind === 'chat' ? `chat:${row.id}` : `file:${row.path}`)}
              renderItem={({ item: row, index }) => (
                <Tap
                  key={'as' in row ? `command:${row.name}` : row.kind === 'chat' ? `chat:${row.id}` : `file:${row.path}`}
                  accessibilityRole="menuitem"
                  accessibilityLabel={labelOf(row)}
                  accessibilityState={{ disabled: menu.status === 'loading', selected: index === 0 }}
                  disabled={menu.status === 'loading'}
                  onPress={() => pick(row)}
                  style={[styles.card, { padding: 10, gap: 2, marginBottom: 6, borderWidth: index === 0 ? 2 : 1 }]}
                >
                  {'as' in row ? (
                    <>
                      <Text style={styles.text}>{`/${row.name}${row.hint ? ` ${row.hint}` : ''}`}</Text>
                      {!!row.description && <Text style={styles.muted}>{row.description}</Text>}
                    </>
                  ) : row.kind === 'chat' ? (
                    <>
                      <Text style={styles.text}>{row.title}</Text>
                      <Text style={styles.muted}>Chat</Text>
                    </>
                  ) : (
                    <>
                      <Text style={styles.text}>{row.directory ? `${row.name}/` : row.name}</Text>
                      <Text style={styles.muted}>{row.path}</Text>
                    </>
                  )}
                </Tap>
              )}
            />
          </View>
        </Enter>
      )}
    </View>
  );
}
