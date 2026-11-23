// What a long press on a Chats-home row opens: a sheet with the chat's own actions, Pin or Unpin, Rename and Archive, the ones the chat's ⋯ menu has, and only the ones this Mac can do (Claude for iOS's row menu has the same three and no swipe).
import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import type { MobileRuntime } from '../contracts';
import { archiveChat, pinChat, renameChat } from '../remote/controls';
import { capabilities, explain } from '../remote/client';
import { useOwnedRequest } from '../remote/useOwnedRequest';
import { useTheme } from '../theme';
import { typo } from '../typography';
import { BottomSheet } from './BottomSheet';
import { ComposerButton } from './ComposerBox';
import { Group, GroupItem } from './Grouped';
import { Icon } from './Icon';
import type { ChatListItem } from './ChatRow';

/** What the home gives the rows' menu: the app's runtime (the Mac the list is of) and a way to read the list again after a change. */
export type RowMenuOwner = { runtime: MobileRuntime; changed: () => void };

type Can = { pin: boolean; rename: boolean; archive: boolean };

/** The sheet for one chat; `open` turns false to close it and the chat stays, so the sheet slides out with its content. */
export function ChatRowMenu({ owner, chat, open, close }: { owner: RowMenuOwner; chat: ChatListItem; open: boolean; close: () => void }) {
  const theme = useTheme();
  const request = useOwnedRequest(owner.runtime);
  const [can, setCan] = useState<Can | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // what this Mac can do is read when the sheet opens (one machine.hello per connection, shared by every screen)
  useEffect(() => {
    if (!open) return;
    setRenaming(false);
    setError(null);
    setName(chat.title ?? '');
    void capabilities(request).then(
      (caps) =>
        setCan({
          pin: !caps.methods || caps.methods.has('chats.pin'),
          rename: caps.renameChats === true,
          archive: caps.archiveChats === true,
        }),
      () => setCan({ pin: false, rename: false, archive: false }),
    );
  }, [open, request, chat.title]);
  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      close();
      owner.changed();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  }
  const none = !!can && !can.pin && !can.rename && !can.archive;
  return (
    <BottomSheet
      open={open}
      title={renaming ? 'Rename chat' : (chat.title ?? 'Untitled chat')}
      onClose={close}
      onBack={renaming ? () => setRenaming(false) : undefined}
    >
      {!!error && (
        <Text accessibilityLiveRegion="polite" style={{ ...typo.subhead, color: theme.bad, marginBottom: 12, paddingHorizontal: 4 }}>
          {error}
        </Text>
      )}
      {renaming ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 4 }}>
          <TextInput
            autoFocus
            value={name}
            onChangeText={setName}
            placeholder="Chat name"
            placeholderTextColor={theme.ink3}
            accessibilityLabel="Chat name"
            returnKeyType="done"
            style={{
              flex: 1,
              minHeight: 48,
              borderRadius: 24,
              paddingHorizontal: 16,
              ...typo.body,
              color: theme.ink,
              backgroundColor: theme.surface,
            }}
          />
          <ComposerButton
            label="Save name"
            strong
            disabled={busy || !name.trim()}
            icon={<Icon name="checkmark" glyph="✓" size={18} color={theme.btnInk} />}
            onPress={() => void act(() => renameChat(request, chat.id, name.trim()))}
          />
        </View>
      ) : none ? (
        <Text style={{ ...typo.subhead, color: theme.ink2, paddingHorizontal: 4 }}>
          Update MoPilot on your computer to pin, rename or archive from your phone.
        </Text>
      ) : (
        !!can && (
          <Group>
            {can.pin && (
              <GroupItem
                key="pin"
                title={chat.pinned ? 'Unpin' : 'Pin'}
                icon={<Icon name={chat.pinned ? 'pin.slash' : 'pin'} glyph="⌃" size={20} color={theme.ink} />}
                onPress={busy ? undefined : () => void act(() => pinChat(request, chat.id, !chat.pinned))}
              />
            )}
            {can.rename && (
              <GroupItem
                key="rename"
                title="Rename"
                icon={<Icon name="pencil" glyph="✎" size={20} color={theme.ink} />}
                onPress={() => setRenaming(true)}
              />
            )}
            {can.archive && (
              <GroupItem
                key="archive"
                title="Archive"
                tone="danger"
                icon={<Icon name="archivebox" glyph="▤" size={20} color={theme.bad} />}
                onPress={busy ? undefined : () => void act(() => archiveChat(request, chat.id))}
              />
            )}
          </Group>
        )
      )}
    </BottomSheet>
  );
}
