// New chat's machine picker (this Mac and its Hosts, in the Mac's own words) and the folder picker for a chat on a Host, as Claude-style sheets.
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { explain, type Owned } from '../remote/client';
import { loadFolders, type Folders } from '../remote/folders';
import type { Machine, MachineTone } from '../remote/machines';
import { useTheme } from '../theme';
import { BottomSheet } from './BottomSheet';
import { Group, GroupItem } from './Grouped';
import { Icon } from './Icon';
import { ErrorLine } from './ui';
import { typo } from '../typography';

/** The state dot the Mac's tone asks for: green, amber, or grey. */
export function ToneDot({ tone }: { tone: MachineTone }) {
  const theme = useTheme();
  const color = tone === 'ok' ? theme.ok : tone === 'warn' ? theme.amber : theme.ink3;
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
}

/** Every machine the Mac runs chats on, each with the Mac's own line; the one picked is checked. */
export function MachineSheet({
  open,
  close,
  machines,
  picked,
  pick,
}: {
  open: boolean;
  close: () => void;
  machines: Machine[];
  picked: string;
  pick: (id: string) => void;
}) {
  return (
    <BottomSheet open={open} title="Run on" onClose={close}>
      <Group>
        {machines.map((m) => (
          <GroupItem
            key={m.id}
            title={m.name}
            detail={m.line}
            icon={<ToneDot tone={m.tone} />}
            end={m.id === picked ? 'check' : 'none'}
            onPress={() => {
              pick(m.id);
              close();
            }}
          />
        ))}
      </Group>
    </BottomSheet>
  );
}

/**
 * A folder on machine `machine`: its roots first, then one level at a time; "Use this folder" picks the one shown.
 * A listing that arrives after another folder was opened is dropped.
 */
export function FolderSheet({
  open,
  close,
  request,
  machine,
  pick,
}: {
  open: boolean;
  close: () => void;
  request: Owned;
  machine: string;
  pick: (path: string) => void;
}) {
  const theme = useTheme();
  const [at, setAt] = useState<string | null>(null);
  const [list, setList] = useState<Folders | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setList(null);
    setError(null);
    loadFolders(request, machine, at).then(
      (f) => alive && setList(f),
      (e: unknown) => alive && setError(explain(e)),
    );
    return () => {
      alive = false;
    };
  }, [open, request, machine, at]);
  const rows = list ? (at === null && list.roots.length ? list.roots : list.entries) : [];
  const shown = list?.path ?? at;
  return (
    <BottomSheet open={open} title="Folder" onClose={close} onBack={at ? () => setAt(null) : undefined}>
      <ErrorLine text={error} />
      {!list && !error && <Text style={{ ...typo.subhead, color: theme.ink2, paddingHorizontal: 4 }}>Loading folders…</Text>}
      {list && (
        <>
          {!!shown && (
            <Group>
              <GroupItem
                key="use"
                title="Use this folder"
                detail={shown}
                tone="link"
                onPress={() => {
                  pick(shown);
                  close();
                }}
              />
            </Group>
          )}
          <Group>
            {rows.map((e) => (
              <GroupItem
                key={e.path}
                title={e.name}
                icon={<Icon name={e.git ? 'arrow.triangle.branch' : 'folder'} glyph={e.git ? '⑂' : '▸'} size={15} color={theme.ink2} />}
                end="chevron"
                onPress={() => setAt(e.path)}
              />
            ))}
          </Group>
          {list.more && (
            <Text style={{ ...typo.footnote, color: theme.ink2, paddingHorizontal: 16 }}>More folders are on the machine.</Text>
          )}
        </>
      )}
    </BottomSheet>
  );
}
