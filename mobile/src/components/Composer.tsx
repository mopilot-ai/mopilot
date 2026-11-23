// The chat's composer as the baseline draws it: one rounded box with the message field, and under it + (attachments), the model pill, a mic, and one round button that sends or stops a running turn (a running turn with text typed shows Stop beside Send).
import { KeyboardMinimize } from './KeyboardMinimize';
import { Icon } from './Icon';
import React, { type ComponentRef, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { armRise, measureTop } from '../sendOrigin';
import { GrowingField } from './GrowingField';
import type { Field } from './ui';
import { useTheme } from '../theme';
import { ComposerButton } from './ComposerBox';
import { typo } from '../typography';
import { usePerfRender } from '../perfLog';

export function Composer({
  draft,
  setDraft,
  placeholder,
  focusKey,
  autoFocus,
  menu,
  menuOpen,
  onAttach,
  tray,
  above,
  bar,
  running,
  disabled,
  stopDisabled,
  stopping: stopRequested = false,
  send,
  stop,
  fieldProps,
  sendLabel = 'Send message',
  attached = false,
}: {
  draft: string;
  setDraft: (text: string) => void;
  placeholder: string;
  /** A new key remounts the field, so it takes focus. */
  focusKey: string;
  autoFocus: boolean;
  /** What the mic opens (the voice note); absent where the app has no media, and then there is no mic. */
  menu?: ReactNode;
  /** Opens the Add to session sheet; absent where the app has no media, and then there is no + button. */
  onAttach?: () => void;
  /** The attached files, as thumbnails at the top of the box. */
  tray?: ReactNode;
  /** Keeps the menu open while something in it (a recording, a transcript) is still going on. */
  menuOpen?: boolean;
  /** Always shown above the box: the attached files, the / and @ menus. */
  above?: ReactNode;
  /** In the box's bar between + and the round button: the model pill. */
  bar?: ReactNode;
  /** A turn is running (working, or waiting for you): with nothing typed the round button stops it; with text it sends, and a smaller Stop sits beside it. */
  running: boolean;
  /** The message cannot be sent now (busy, an upload under way, or nothing typed). */
  disabled: boolean;
  stopDisabled: boolean;
  /** Stop was tapped and the turn has not ended yet: the button says so at once, instead of staying as it was. */
  stopping?: boolean;
  send: () => void;
  /** Absent where no turn runs (a new chat), and then nothing stops. */
  stop?: () => void;
  /** More for the message field: a screen that watches the caret (the / and @ menus) takes the text and the selection itself. */
  fieldProps?: Partial<React.ComponentProps<typeof Field>>;
  /** What the round send button is called; a new chat starts instead of sending. */
  sendLabel?: string;
  /** Files are attached and ready: they send without words. */
  attached?: boolean;
}) {
  usePerfRender('Composer');
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  // words or files: either is a message to send, and with one of them a running turn shows Send, not only Stop
  const typed = !!draft.trim() || !!attached;
  const stopping = running && !typed;
  const shown = open || !!menuOpen;
  const box = useRef<ComponentRef<typeof View>>(null);
  return (
    <View
      style={{ flexShrink: 1, minHeight: 0, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 8, gap: 8, backgroundColor: theme.bg }}
    >
      {above}
      {/* mounted even when closed, so a recording in it is not cut off by closing the menu */}
      {menu && <View style={{ display: shown ? 'flex' : 'none', gap: 8 }}>{menu}</View>}
      <View
        ref={box}
        style={{
          flexShrink: 0,
          borderRadius: 28,
          borderWidth: 1,
          borderColor: theme.line,
          backgroundColor: theme.surface,
          paddingTop: 12,
          paddingBottom: 10,
          paddingLeft: 16,
          paddingRight: 12,
          boxShadow: '0px 2px 12px rgba(0, 0, 0, 0.04)',
          gap: 10,
        }}
      >
        {tray}
        <GrowingField
          minHeight={24}
          maxHeight={140}
          key={focusKey}
          multiline
          autoFocus={autoFocus}
          placeholder={placeholder}
          value={draft}
          onChangeText={setDraft}
          {...fieldProps}
          style={{
            borderWidth: 0,
            backgroundColor: 'transparent',
            paddingHorizontal: 0,
            paddingVertical: 2,
            ...typo.body,
          }}
        />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {onAttach && (
            <ComposerButton label="Add to session" onPress={onAttach} icon={<Icon name="plus" glyph="+" size={18} color={theme.ink} />} />
          )}
          {bar}
          <View style={{ flex: 1 }} />
          <KeyboardMinimize />
          {menu && (
            <ComposerButton
              label={shown ? 'Close dictation' : 'Dictate'}
              disabled={!!menuOpen}
              onPress={() => setOpen(!shown)}
              icon={<Icon name={shown ? 'xmark' : 'mic'} glyph={shown ? '×' : '🎤'} size={18} color={theme.ink} />}
            />
          )}
          {/* a follow-up is typed while a turn runs: the round button sends it, and Stop stays beside it, not instead of it */}
          {running && typed && (
            <ComposerButton
              label={stopRequested ? 'Stopping…' : 'Stop this chat’s turn'}
              disabled={stopDisabled || stopRequested}
              onPress={stop!}
              icon={
                stopRequested ? (
                  <ActivityIndicator color={theme.ink} />
                ) : (
                  <View style={{ width: 13, aspectRatio: 1, borderRadius: 3, backgroundColor: theme.ink }} />
                )
              }
            />
          )}
          {stopping ? (
            <ComposerButton
              strong
              label={stopRequested ? 'Stopping…' : 'Stop this chat’s turn'}
              disabled={stopDisabled || stopRequested}
              onPress={stop!}
              icon={
                stopRequested ? (
                  <ActivityIndicator color={theme.btnInk} />
                ) : (
                  <View style={{ width: 13, aspectRatio: 1, borderRadius: 3, backgroundColor: theme.btnInk }} />
                )
              }
            />
          ) : (
            <ComposerButton
              strong
              label={sendLabel}
              disabled={disabled}
              onPress={() => {
                armRise(measureTop(box.current));
                send();
              }}
              icon={<Icon name="arrow.up" glyph="↑" size={18} color={theme.btnInk} />}
            />
          )}
        </View>
      </View>
    </View>
  );
}
