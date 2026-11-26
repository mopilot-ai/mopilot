// Claude for iOS's "Add to session" sheet: a Camera tile and the newest photos to tick, an Attach capsule, and cards for adding files and for the permission, computer and skills of the chat.
import { useEffect, useRef, useState } from 'react';
import { Image as PhotoImage } from 'expo-image';
import { ScrollView, Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import type { Media, Prep, Recent } from '../platform/media';
import type { Picked } from '../remote/upload';
import { AccessDenied } from '../platform/accessDenied';
import { explain } from '../remote/client';
import { MAX_FILES, type useAttachments } from '../remote/useAttachments';
import { useTheme } from '../theme';
import { BottomSheet } from './BottomSheet';
import { Group, GroupItem } from './Grouped';
import { Icon } from './Icon';
import { OpenSettings } from './OpenSettings';
import { typo } from '../typography';

const TILE = 108;
/** How long "Getting your selection…" runs on its own before it says that a long video takes a while: the picker copies each original itself and has no percentage to give. */
export const hint = { after: 6000 };
/** What is being done to the video: made smaller, or (after a size did not fit) a smaller size is tried. */
const line = (prep: Prep) => {
  const what = prep.count > 1 ? `video ${prep.index} of ${prep.count}` : 'the video';
  return prep.retry ? `Trying a smaller size for ${what}` : `Making ${what} smaller`;
};
const none: Recent = { access: 'denied', photos: [] };

/** A row that opens another page of the chat: its grey value and where it leads. */
export type SheetRow = { value?: string; open: () => void };

export function AddToSessionSheet({
  open,
  onClose,
  media,
  files,
  permission,
  computer,
  skills,
}: {
  open: boolean;
  onClose: () => void;
  media: Media;
  files: ReturnType<typeof useAttachments>;
  /** only where the chat's agent lists permission modes the phone may set */
  permission?: SheetRow;
  computer?: SheetRow;
  /** only where the composer has the / menu: types the slash for the person */
  skills?: () => void;
}) {
  const theme = useTheme();
  const [recent, setRecent] = useState<Recent>(none);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // a system picker (camera or the full library) is on its way up: iOS shows one at a time, so its buttons wait
  const [opening, setOpening] = useState(false);
  // the library picker has been asked for. The picker gives no signal when it closes (its promise resolves after the choice is exported), so one line has to be true while it is open and while the choice is read: what the app is doing, not what the person should do
  const [preparing, setPreparing] = useState(false);
  // a video being made smaller: which one and how far, and what stops it (the Cancel under the line, the sheet closing)
  const [prep, setPrep] = useState<Prep | null>(null);
  const stopper = useRef<AbortController | null>(null);
  // the picker has handed over a pick with a video in it, and reading it has run long with nothing to show: say what it is
  const [videos, setVideos] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!videos || prep) return;
    const timer = setTimeout(() => setSlow(true), hint.after);
    return () => clearTimeout(timer);
  }, [videos, prep]);
  const [error, setError] = useState<string | null>(null);
  // a refusal the system will not ask about again: the way forward is Settings
  const [denied, setDenied] = useState(false);
  // a read that finishes after the sheet closed adds nothing
  const live = useRef(false);
  useEffect(() => {
    live.current = open;
    if (!open) return;
    setSelected([]);
    setError(null);
    setDenied(false);
    setBusy(false);
    setOpening(false);
    setPreparing(false);
    setPrep(null);
    setVideos(false);
    setRecent(none);
    void media.recent().then((r) => live.current && setRecent(r));
    return () => {
      live.current = false;
      // a video still being made smaller is not wanted once the sheet is gone: the export stops and takes its temporary files with it
      stopper.current?.abort();
    };
  }, [open, media]);
  const room = MAX_FILES - files.items.length;

  async function run(work: () => Promise<void>) {
    setError(null);
    setDenied(false);
    try {
      await work();
    } catch (e) {
      if (!live.current) return;
      setError(explain(e));
      setDenied(e instanceof AccessDenied);
    }
  }
  /** One photo from the camera: added, and the sheet is done. */
  const one = (pick: () => Promise<Picked | null>) =>
    run(async () => {
      setOpening(true);
      try {
        const photo = await pick();
        if (!photo || !live.current) return;
        files.add(photo);
        onClose();
      } finally {
        if (live.current) setOpening(false);
      }
    });
  /** What the person chose in the system picker: every photo and video added in the order chosen, and the sheet is done unless something was left out or could not be read. */
  const several = () =>
    run(async () => {
      setOpening(true);
      setPreparing(true);
      const control = new AbortController();
      stopper.current = control;
      try {
        const { picked, refused, cancelled } = await media.library(room, {
          signal: control.signal,
          progress: (next) => live.current && setPrep(next),
          handed: ({ videos: n }) => live.current && setVideos(n > 0),
        });
        if (!live.current) return;
        for (const file of picked.slice(0, room)) files.add(file);
        // the person stopped it: what was ready is in the message, and the sheet stays for the rest
        if (cancelled) return;
        const cut = picked.length > room ? 'Up to ten files per message; the rest were left out.' : '';
        const lost = refused.length === 1 ? refused[0] : refused.length ? `${refused.length} files could not be added.` : '';
        // both facts are told when both happened: a left-out item and one that could not be read
        if (cut || lost) setError([cut, lost].filter(Boolean).join(' '));
        else if (picked.length) onClose();
      } finally {
        stopper.current = null;
        if (live.current) {
          setOpening(false);
          setPreparing(false);
          setPrep(null);
          setVideos(false);
        }
      }
    });
  // a tile with no room left is disabled, so a tick always has room
  const toggle = (id: string) => setSelected((old) => (old.includes(id) ? old.filter((x) => x !== id) : [...old, id]));

  async function attach() {
    setBusy(true);
    const failed: string[] = [];
    for (const id of selected) {
      try {
        const [photo] = await media.photos([id]);
        if (!live.current) return;
        files.add(photo);
      } catch {
        failed.push(id);
      }
    }
    if (!live.current) return;
    setBusy(false);
    if (!failed.length) return onClose();
    // the photos that could not be read stay ticked, so they can be tried again
    setSelected(failed);
    setError(failed.length === 1 ? 'One photo could not be read.' : `${failed.length} photos could not be read.`);
  }
  async function addFiles() {
    const picked = await media.files();
    if (!live.current || !picked.length) return;
    for (const file of picked.slice(0, room)) files.add(file);
    if (picked.length > room) setError('Up to ten files per message; the rest were left out.');
    else onClose();
  }
  /** A row that leaves this sheet for the page it names. */
  const leave = (go: () => void) => () => {
    onClose();
    go();
  };

  const count = selected.length;
  const label = `Attach ${count} ${count === 1 ? 'photo' : 'photos'}`;
  return (
    <BottomSheet
      open={open}
      title="Add to session"
      onClose={onClose}
      grabber
      right={
        <Tap
          accessibilityRole="button"
          accessibilityLabel="Photos"
          disabled={room <= 0 || opening}
          hitSlop={8}
          onPress={() => void several()}
        >
          <Text style={{ ...typo.body, color: room <= 0 ? theme.ink3 : theme.ink }}>Photos</Text>
        </Tap>
      }
      footer={
        count > 0 ? (
          <Tap
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={() => void attach()}
            style={{
              marginTop: 8,
              minHeight: 56,
              borderRadius: 28,
              backgroundColor: theme.btn,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: busy ? 0.6 : 1,
            }}
          >
            <Text style={{ ...typo.bodySemibold, color: theme.btnInk }}>{busy ? 'Attaching…' : label}</Text>
          </Tap>
        ) : null
      }
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8 }}
        style={{ marginBottom: 16, flexGrow: 0 }}
      >
        <Tap
          accessibilityRole="button"
          accessibilityLabel="Camera"
          disabled={room <= 0 || opening}
          onPress={() => void one(() => media.camera())}
          style={{
            width: TILE,
            height: TILE,
            borderRadius: 24,
            backgroundColor: theme.sunken,
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            opacity: room <= 0 ? 0.5 : 1,
          }}
        >
          <Icon name="camera" glyph="◉" size={26} color={theme.ink} />
          <Text style={{ ...typo.subhead, color: theme.ink }}>Camera</Text>
        </Tap>
        {recent.photos.map((photo) => {
          const on = selected.includes(photo.id);
          const blocked = !on && selected.length >= room;
          return (
            <Tap
              key={photo.id}
              accessibilityRole="button"
              accessibilityLabel="Photo"
              accessibilityState={{ selected: on, disabled: blocked }}
              disabled={blocked}
              onPress={() => toggle(photo.id)}
              style={{ width: TILE, height: TILE, borderRadius: 24, overflow: 'hidden', backgroundColor: theme.sunken }}
            >
              {/* expo-image draws the library's ph:// address (React Native's own Image cannot) and fetches an iCloud original's thumbnail */}
              <PhotoImage source={{ uri: photo.uri }} contentFit="cover" style={{ width: TILE, height: TILE }} />
              {on && (
                <View
                  style={{
                    position: 'absolute',
                    top: 8,
                    right: 8,
                    width: 28,
                    height: 28,
                    borderRadius: 14,
                    backgroundColor: '#ffffff',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon name="checkmark" glyph="✓" size={15} color="#1a1a18" />
                </View>
              )}
            </Tap>
          );
        })}
      </ScrollView>
      {recent.access === 'limited' && (
        <Tap
          accessibilityRole="button"
          accessibilityLabel="Select more photos"
          onPress={() =>
            void run(async () => {
              await media.manageLimited();
              const next = await media.recent();
              if (live.current) setRecent(next);
            })
          }
          style={{ marginBottom: 12, paddingHorizontal: 4 }}
        >
          <Text style={{ ...typo.subhead, color: theme.ink2 }}>
            Showing the photos you shared. <Text style={{ color: theme.accent }}>Select more</Text>
          </Text>
        </Tap>
      )}
      {/* the system may be asking for camera access on top of the app: say so, or the tap looks dead */}
      {opening && (
        <Text
          accessibilityLiveRegion="polite"
          // the percentage is a value, not part of the label: a screen reader says what is happening, and the number when asked, not at every step
          accessibilityLabel={prep ? line(prep) : undefined}
          accessibilityValue={prep ? { text: `${Math.round(prep.fraction * 100)} percent` } : undefined}
          style={{ ...typo.subhead, color: theme.ink2, marginBottom: 12, paddingHorizontal: 4 }}
        >
          {prep
            ? `${line(prep)}… ${Math.round(prep.fraction * 100)}%`
            : preparing
              ? slow
                ? 'Getting your selection… long videos take a while.'
                : 'Getting your selection…'
              : 'Opening… answer the prompt if iOS asks.'}
        </Text>
      )}
      {prep && (
        <Tap
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={() => stopper.current?.abort()}
          style={{ marginBottom: 12, paddingHorizontal: 4 }}
        >
          <Text style={{ ...typo.subhead, color: theme.accent }}>Cancel</Text>
        </Tap>
      )}
      {!!error && (
        <Text accessibilityLiveRegion="polite" style={{ ...typo.subhead, color: theme.bad, marginBottom: 12, paddingHorizontal: 4 }}>
          {error}
        </Text>
      )}
      {denied && <OpenSettings />}
      <Group>
        <GroupItem
          key="files"
          title="Add files"
          detail={room <= 0 ? 'Up to ten files' : undefined}
          icon={<Icon name="doc.badge.plus" glyph="▤" size={20} color={theme.ink} />}
          onPress={room <= 0 ? undefined : () => void run(addFiles)}
        />
      </Group>
      {(permission || computer || skills) && (
        <Group>
          {permission && (
            <GroupItem
              key="permission"
              title="Permission"
              value={permission.value}
              end="chevron"
              icon={<Icon name="hand.raised" glyph="✋" size={20} color={theme.ink} />}
              onPress={leave(permission.open)}
            />
          )}
          {computer && (
            <GroupItem
              key="computer"
              title="Computer"
              value={computer.value}
              end="chevron"
              icon={<Icon name="desktopcomputer" glyph="▭" size={20} color={theme.ink} />}
              onPress={leave(computer.open)}
            />
          )}
          {skills && (
            <GroupItem
              key="skills"
              title="Skills"
              end="chevron"
              icon={<Icon name="text.document" glyph="▤" size={20} color={theme.ink} />}
              onPress={leave(skills)}
            />
          )}
        </Group>
      )}
    </BottomSheet>
  );
}
