// The pictures a message of yours carries, as small tiles above its text (right-aligned like the bubble): each is read from the computer when its row mounts, and a tap opens it full screen. `local` are pictures this phone already holds (a message not yet sent).
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Image, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { useTheme } from '../theme';
import { useTranslation } from '../ui/i18n';
import { ImageViewer } from './ImageViewer';
import { Icon } from './Icon';
import { Spark } from './Spark';
import { FULL_SIDE, THUMB_SIDE } from '../remote/messageImage';

/** A tile's side, in points: about three to a row, as Claude's iOS app lays a message's pictures. */
export const TILE = 96;

/** Reads one picture of a message from the computer by its place, at the longest side asked; null when there is none to show. */
type LoadMessageImage = (itemId: string, index: number, side: number) => Promise<string | null>;
const Loader = createContext<LoadMessageImage | null>(null);

/** The chat screen hands its way to the computer's pictures to every message below it. */
export function MessageImageProvider({ load, children }: { load?: LoadMessageImage; children: ReactNode }) {
  return <Loader.Provider value={load ?? null}>{children}</Loader.Provider>;
}

function Tile({
  itemId,
  index,
  uri,
  side,
  onOpen,
}: {
  itemId?: string;
  index: number;
  uri?: string;
  side: number;
  onOpen: (uri: string, fetched: boolean) => void;
}) {
  const theme = useTheme();
  const load = useContext(Loader);
  const [shown, setShown] = useState<{ owner: unknown; itemId?: string; uri?: string; picture: string } | null>(null);
  const picture = uri ?? (shown?.owner === load && shown.itemId === itemId && shown.uri === uri ? shown.picture : null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (uri || !load || !itemId) {
      if (!uri) setFailed(true);
      return;
    }
    void attempt; // a tap on a failed tile asks again
    let live = true;
    setFailed(false);
    void load(itemId, index, side).then((picture) => {
      if (!live) return;
      if (picture) setShown({ owner: load, itemId, uri, picture });
      else setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [uri, load, itemId, index, side, attempt]);
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={picture ? 'Open picture' : failed ? 'Picture unavailable, tap to try again' : 'Loading picture'}
      onPress={() => (picture ? onOpen(picture, !uri) : failed && !uri && setAttempt(attempt + 1))}
      style={{
        width: TILE,
        height: TILE,
        borderRadius: 14,
        overflow: 'hidden',
        backgroundColor: theme.sunken,
        borderWidth: 1,
        borderColor: theme.glassLine,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {picture ? (
        <Image source={{ uri: picture }} accessibilityLabel="Picture" resizeMode="cover" style={{ width: TILE, height: TILE }} />
      ) : failed ? (
        <Icon name="photo" glyph="▨" size={24} color={theme.ink3} />
      ) : (
        <Spark size={18} spin />
      )}
    </Tap>
  );
}

const places0 = (total: number) => Array.from({ length: total }, (_, index) => index);

function MessageImageTiles({ itemId, count, local = [] }: { itemId?: string; count: number; local?: string[] }) {
  const load = useContext(Loader);
  const { t } = useTranslation();
  const [open, setOpen] = useState<{
    owner: typeof load;
    index: number;
    /** the picture opened first, which `uri` is the thumbnail of */
    first: number;
    uri: string;
    fetched: boolean;
  } | null>(null);
  // the full-size pictures read so far, by place (null: could not be read): the one on screen and its neighbours, so a swipe finds the next ready
  const [fulls, setFulls] = useState<{ owner: typeof load; pictures: Record<number, string | null> }>({ owner: load, pictures: {} });
  const current = open?.owner === load ? open : null;
  const total = local.length || count;
  const known = fulls.owner === load ? fulls.pictures : {};
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  // asked once each (a reply still on its way is not asked for again as the others arrive), and again for a new owner of the connection
  const asked = useRef<{ owner: typeof load; places: Set<number> }>({ owner: load, places: new Set() });
  useEffect(() => {
    if (!current?.fetched || !load || !itemId) return;
    if (asked.current.owner !== load) asked.current = { owner: load, places: new Set() };
    for (const place of [current.index, current.index + 1, current.index - 1]) {
      if (place < 0 || place >= total || asked.current.places.has(place)) continue;
      asked.current.places.add(place);
      const done = (picture: string | null) =>
        alive.current && setFulls((old) => ({ owner: load, pictures: { ...(old.owner === load ? old.pictures : {}), [place]: picture } }));
      void load(itemId, place, FULL_SIDE).then(done, () => done(null));
    }
  }, [current, load, itemId, total]);
  if (total <= 0) return null;
  // every picture of the message for the viewer: the one opened shows its thumbnail until its full size comes
  const pages = places0(total).map((index) => ({
    key: `picture-${index}`,
    uri: local[index] ?? known[index] ?? (current?.first === index ? current.uri : null),
    name: t('viewer.pictureOf', { n: index + 1, total }),
  }));
  // a message's pictures have no identity but their place
  const places = places0(total).map((index) => ({ key: `picture-${index}`, index }));
  return (
    <View
      style={{
        alignSelf: 'flex-end',
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
        gap: 6,
        maxWidth: '82%',
        marginTop: 6,
        marginBottom: 6,
      }}
    >
      {places.map(({ key, index }) => (
        <Tile
          key={key}
          itemId={itemId}
          index={index}
          uri={local[index]}
          side={THUMB_SIDE}
          onOpen={(uri, fetched) => setOpen({ owner: load, index, first: index, uri, fetched })}
        />
      ))}
      <ImageViewer
        uri={current ? (pages[current.index].uri ?? current.uri) : null}
        name={current ? pages[current.index].name : ''}
        pages={pages}
        index={current?.index ?? 0}
        onIndex={(index) => current && setOpen({ ...current, index })}
        close={() => setOpen(null)}
      />
    </View>
  );
}

export function MessageImages(props: { itemId?: string; count: number; local?: string[] }) {
  return <MessageImageTiles key={props.itemId ?? JSON.stringify(props.local)} {...props} />;
}
