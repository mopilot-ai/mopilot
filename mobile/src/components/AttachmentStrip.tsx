// The attached files inside the composer box, as Claude for iOS draws them: large rounded thumbnails with a dark round × on top, a dimmed tile with progress while uploading, and a red ! to retry a failed one.
import { useState } from 'react';
import { Image, Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import type { Item } from '../remote/useAttachments';
import { useTheme } from '../theme';
import { Icon } from './Icon';
import { pictureSource } from '../presentation/messagePictures';
import { ImageViewer } from './ImageViewer';
import { typo } from '../typography';

const TILE = 80;
const fill = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' } as const;

const isImage = (item: Item) => item.file.mime.startsWith('image/');
const sourceOf = (item: Item) => pictureSource(item.file);
const percent = (item: Item) => Math.min(100, Math.round((item.sent / Math.max(1, item.total)) * 100));
const stateWords = (item: Item) =>
  item.state === 'sending'
    ? `sending ${percent(item)}%`
    : item.state === 'done'
      ? 'attached'
      : item.state === 'cancelled'
        ? 'cancelled'
        : `failed: ${item.error}`;

export function AttachmentStrip({ items, retry, remove }: { items: Item[]; retry: (key: number) => void; remove: (key: number) => void }) {
  const theme = useTheme();
  // the key of the image being looked at; it closes with the tile (removed meanwhile)
  const [viewing, setViewing] = useState<number | null>(null);
  const images = items.filter(isImage);
  const at = images.findIndex((i) => i.key === viewing);
  const looked = images[at];
  if (!items.length) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <ImageViewer
        uri={looked ? sourceOf(looked) : null}
        name={looked?.file.name ?? ''}
        pages={images.map((i) => ({ key: String(i.key), uri: sourceOf(i), name: i.file.name }))}
        index={Math.max(0, at)}
        onIndex={(to) => setViewing(images[to].key)}
        close={() => setViewing(null)}
      />
      {items.map((item) => (
        <View key={item.key} style={{ width: TILE, height: TILE }}>
          <View
            accessible
            accessibilityLabel={`${item.file.name}, ${stateWords(item)}`}
            style={{
              width: TILE,
              height: TILE,
              borderRadius: 18,
              overflow: 'hidden',
              backgroundColor: theme.sunken,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {isImage(item) ? (
              <Image source={{ uri: sourceOf(item) }} accessibilityLabel={item.file.name} style={{ width: TILE, height: TILE }} />
            ) : (
              <View style={{ alignItems: 'center', gap: 4, paddingHorizontal: 6 }}>
                <Icon name="doc" glyph="▤" size={22} color={theme.ink2} />
                <Text numberOfLines={2} style={{ ...typo.caption2, color: theme.ink2, textAlign: 'center' }}>
                  {item.file.name}
                </Text>
              </View>
            )}
            {item.state === 'sending' && (
              <View style={[fill, { backgroundColor: 'rgba(0,0,0,0.4)' }]}>
                <Text style={{ ...typo.subheadSemibold, color: '#ffffff' }}>{`${percent(item)}%`}</Text>
              </View>
            )}
          </View>
          {/* a picture opens full screen; not while it uploads, and a failed one's tap is Retry (this sits under it) */}
          {isImage(item) && item.state !== 'sending' && (
            <Tap
              feel="none"
              accessibilityRole="button"
              accessibilityLabel={`View ${item.file.name}`}
              onPress={() => setViewing(item.key)}
              style={[fill, { borderRadius: 18 }]}
            />
          )}
          {(item.state === 'failed' || item.state === 'cancelled') && (
            <Tap
              accessibilityRole="button"
              accessibilityLabel={`Retry upload of ${item.file.name}`}
              onPress={() => retry(item.key)}
              style={[fill, { borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.45)' }]}
            >
              <View
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 14,
                  backgroundColor: theme.bad,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ ...typo.calloutSemibold, color: '#ffffff' }}>!</Text>
              </View>
            </Tap>
          )}
          <Tap
            accessibilityRole="button"
            // no hit slop: the failed tile's ! sits at the tile's centre, and a wider ✕ would take a tap meant for Retry (found on the iPhone)
            accessibilityLabel={`Remove ${item.file.name}`}
            onPress={() => remove(item.key)}
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              width: 28,
              height: 28,
              borderRadius: 14,
              backgroundColor: 'rgba(26,26,24,0.85)',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="xmark" glyph="×" size={13} color="#ffffff" />
          </Tap>
        </View>
      ))}
    </View>
  );
}
