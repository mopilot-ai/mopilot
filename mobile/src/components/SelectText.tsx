// A message's long-press menu and its "Select Text" sheet: Copy takes the whole message, Select Text opens it as read-only text the system selects any range of (handles, Copy, Look Up, Translate, Share), as Claude for iOS does.
import { useContext, useState, type ReactNode } from 'react';
import { ActionSheetIOS, Modal, Platform, Text, TextInput, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { useTheme } from '../theme';
import { typo } from '../typography';
import { copyText } from '../platform/clipboard';
import { ReplyContext } from '../replyContext';
import { useTranslation } from '../ui/i18n';

function Sheet({ text, close }: { text: string; close: () => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View style={{ flex: 1, backgroundColor: theme.bg }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingTop: 16,
            paddingBottom: 8,
          }}
        >
          <Text accessibilityRole="header" style={{ ...typo.title3, color: theme.ink }}>
            {t('message.selectText')}
          </Text>
          <Tap
            accessibilityRole="button"
            accessibilityLabel={t('message.done')}
            onPress={close}
            hitSlop={8}
            style={{ minHeight: 44, justifyContent: 'center' }}
          >
            <Text style={{ ...typo.body, color: theme.accent }}>{t('message.done')}</Text>
          </Tap>
        </View>
        {/* a read-only text view: iOS selects any range of it and offers Copy, Look Up, Translate and Share */}
        <TextInput
          multiline
          editable={false}
          scrollEnabled
          value={text}
          accessibilityLabel={text}
          style={{ flex: 1, paddingHorizontal: 16, paddingTop: 8, ...typo.body, color: theme.ink }}
        />
      </View>
    </Modal>
  );
}

/**
 * The menu a long press on a message opens, and the sheet it leads to (on a code block, table or quote it starts with Ask, where the chat has a composer). `copy` is what Copy puts on the clipboard (the message as written),
 * `plain` makes what Select Text shows (the message without its marks), when it is asked for. `a11y` is the same two actions for VoiceOver, to put on the message's first block.
 */
export function useMessageMenu(copy: string, plain: () => string) {
  const { t } = useTranslation();
  const [selecting, setSelecting] = useState(false);
  // the chat's composer takes a quote: a code block, table or quote can be asked about whole, as selected words can (#5359)
  const ask = useContext(ReplyContext);
  const select = () => setSelecting(true);
  const copyAll = () => void copyText(copy);
  /** `block`: the code block or table that was pressed, which the menu then offers to copy alone. */
  const show = (block?: { kind: 'code' | 'table' | 'block'; text: string }) => {
    // Android has no system menu here: it goes straight to the selectable text
    if (Platform.OS !== 'ios') return select();
    const actions = [
      ...(block && ask ? [{ label: t('message.ask'), run: () => ask(block.text) }] : []),
      ...(block && block.kind !== 'block'
        ? [{ label: t(block.kind === 'code' ? 'message.copyCode' : 'message.copyTable'), run: () => void copyText(block.text) }]
        : []),
      { label: t('message.copy'), run: copyAll },
      { label: t('message.selectText'), run: select },
    ];
    ActionSheetIOS.showActionSheetWithOptions(
      { options: [...actions.map((a) => a.label), t('message.cancel')], cancelButtonIndex: actions.length },
      (index) => actions[index]?.run(),
    );
  };
  const onBlock = (kind: 'code' | 'table' | 'block', text: string) => show({ kind, text });
  const a11y = {
    accessibilityActions: [
      { name: 'copy', label: t('message.copy') },
      { name: 'selectText', label: t('message.selectText') },
    ],
    onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) => (e.nativeEvent.actionName === 'copy' ? copyAll() : select()),
  };
  const sheet: ReactNode = selecting ? <Sheet text={plain()} close={() => setSelecting(false)} /> : null;
  /** the whole message's menu (a long press hands over an event, which `show` must not take for a block) */
  const open = () => show();
  return { open, onBlock, sheet, a11y, copyAll, select };
}
