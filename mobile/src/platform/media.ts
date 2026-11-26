// The phone's library, camera and microphone behind one small interface, so screens and tests never touch the native modules.
import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as MediaLibrary from 'expo-media-library/legacy';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { AudioModule, RecordingPresets, setAudioModeAsync } from 'expo-audio';
import { File } from 'expo-file-system';
import type { Picked } from '../remote/upload';
import { AccessDenied } from './accessDenied';
import { videoCompressor, type VideoCompressor } from './videoCompress';
import { perf } from '../perfLog';
import { prepareVideo, removeCopy, Stopped } from './videoPrep';

export type Voice = { base64: string; mime: 'audio/wav' };
/** What the app may read of the photo library: all of it, only the photos the person shared with the app, or none. */
export type LibraryAccess = 'full' | 'limited' | 'denied';
export type RecentPhoto = { id: string; uri: string };
/** What the library picker gave back: every chosen photo or video that could be read, in the order it was chosen, and the reason for each one that could not. */
export type Chosen = { picked: Picked[]; refused: string[]; cancelled?: boolean };
/** What the sheet says while a video is made smaller: which video of how many, and how far (0 to 1) the export of it is. */
export type Prep = { index: number; count: number; fraction: number; retry?: boolean };
/** What the person may do while the choice is made ready: watch it, and stop it. */
export type PrepHooks = {
  signal?: AbortSignal;
  progress?: (prep: Prep) => void;
  /** The picker has handed the choice over: how many of the items are videos (they are now being read or made smaller). */
  handed?: (pick: { videos: number }) => void;
};
/** The photos the Add to session strip shows; `denied` always comes with no photos. */
export type Recent = { access: LibraryAccess; photos: RecentPhoto[] };
/** How many recent photos the strip loads. */
export const RECENT_PHOTOS = 30;
/** The longest side of a photo sent from the library: a 48 MP photo stays far below the Mac's 20 MB file limit. */
export const LONG_SIDE = 2048;
export interface Media {
  /** The newest photos for the strip. Asks for access the first time only; a refusal, or a platform without it, is `denied` and never throws. */
  recent(): Promise<Recent>;
  /** Opens the system's picker for the photos a Limited-access person shares with the app. */
  manageLimited(): Promise<void>;
  /** Reads the chosen library photos as JPEG; one that cannot be read rejects with the reason. */
  photos(ids: string[]): Promise<Picked[]>;
  /** The system's file picker: any number of files, empty when the person cancels. */
  files(): Promise<Picked[]>;
  /** The system's photo and video picker, for up to `room` items; nothing chosen (a cancel, or a picker already open) is empty, and it needs no permission. */
  library(room: number, prep?: PrepHooks): Promise<Chosen>;
  camera(): Promise<Picked | null>;
  startRecording(): Promise<void>;
  /** Stops and returns the clip the Mac's engine reads. */
  stopRecording(): Promise<Voice>;
  cancelRecording(): Promise<void>;
  /** How loud the recording is right now, 0 to 1; null when nothing is recording or the device does not say. Only drawn, never kept or sent. */
  level(): number | null;
}

const photoOf = (asset: ImagePicker.ImagePickerAsset): Picked => {
  if (!asset.base64) throw new Error('That photo could not be read.');
  return { name: asset.fileName ?? 'photo.jpg', mime: asset.mimeType ?? 'image/jpeg', base64: asset.base64, uri: asset.uri };
};
const asPicked = (result: ImagePicker.ImagePickerResult): Picked | null => {
  const asset = result.canceled ? null : result.assets[0];
  return asset ? photoOf(asset) : null;
};
const picker = { base64: true, quality: 0.8, mediaTypes: ['images' as const] };
/**
 * The library picker's options. Several items at once (never `allowsEditing`, which turns iOS back to one), in the order they were
 * tapped, as many as the message has room for (0 would mean no limit). The picker fills `base64` for photos only. A video comes as the
 * original when the native module can make it smaller (an iCloud one is downloaded for it); a shell without the module has the picker
 * export it as 720p H.264, as before.
 */
const libraryOptions = (room: number, compressor: VideoCompressor | null) => ({
  ...picker,
  mediaTypes: ['images' as const, 'videos' as const],
  allowsMultipleSelection: true,
  selectionLimit: Math.max(1, room),
  orderedSelection: true,
  videoExportPreset: compressor ? ImagePicker.VideoExportPreset.Passthrough : ImagePicker.VideoExportPreset.H264_1280x720,
  // The picker copies each original itself. With the original asked for and the library readable it copies the file as it is; where it cannot read the library it
  // falls back to the item's own file, which the system may convert to a more compatible format (a slow re-encode of a long video) unless the current
  // representation is asked for. We make the size ourselves, so the original is what we want.
  ...(compressor ? { preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current } : {}),
  shouldDownloadFromNetwork: true,
});
/** Each chosen item made ready, one after another: a failure is that item's own, a cancel ends the rest. */
const readAll = async (result: ImagePicker.ImagePickerResult, compressor: VideoCompressor | null, prep?: PrepHooks): Promise<Chosen> => {
  const out: Chosen = { picked: [], refused: [] };
  const assets = result.canceled ? [] : result.assets;
  const videos = assets.filter((a) => a.type === 'video').length;
  // a killed app leaves these full-size copies in the picker's cache: the module is told which they are, and removes any still there at the next launch
  compressor?.track(assets.filter((a) => a.type === 'video').map((a) => a.uri));
  let video = 0;
  // what is left unread when the person stops it: each is a full-size copy in the picker's cache, so they are cleared, not left for later
  const stop = (from: number): Chosen => {
    for (const rest of assets.slice(from)) removeCopy(rest.uri, compressor);
    return { ...out, cancelled: true };
  };
  for (const [at, asset] of assets.entries()) {
    if (prep?.signal?.aborted) return stop(at);
    try {
      if (asset.type !== 'video') out.picked.push(photoOf(asset));
      else {
        const index = ++video;
        out.picked.push(
          await prepareVideo(asset, {
            compressor,
            id: `video-${index}-${Date.now()}`,
            signal: prep?.signal,
            progress: (fraction, retry) => prep?.progress?.({ index, count: videos, fraction, retry }),
          }),
        );
      }
    } catch (e) {
      if (e instanceof Stopped) return stop(at + 1);
      out.refused.push((e as Error).message);
    }
  }
  return out;
};

let recorder: InstanceType<typeof AudioModule.AudioRecorder> | null = null;

/** iOS refuses to prepare a recorder until the audio session allows recording, and keeps the whole session in record mode until it is told otherwise. */
const recordingMode = (on: boolean) =>
  setAudioModeAsync(on ? { allowsRecording: true, playsInSilentMode: true } : { allowsRecording: false });
/** Back to playback after a recording; a session that cannot be switched must not lose the clip or hide why a recording failed. */
const playbackAgain = () => recordingMode(false).catch(() => undefined);

/** Start, stop and cancel run one after another: each changes the one recorder and the audio session, and an overlap would leave either in the wrong state. */
let line: Promise<unknown> = Promise.resolve();
const inOrder = <T>(work: () => Promise<T>): Promise<T> => {
  const result = line.then(work, work);
  line = result.catch(() => undefined);
  return result;
};

/** Library photos are read on iOS only: Android's system picker needs no permission and the store build asks for no storage access. */
const libraryAvailable = () => Platform.OS === 'ios';
const accessOf = (p: MediaLibrary.PermissionResponse): LibraryAccess =>
  !p.granted ? 'denied' : p.accessPrivileges === 'limited' ? 'limited' : 'full';

/** iOS shows one system picker at a time. A tap while one is open (a double tap, or the other button) is dropped, not queued, so no second picker pops up after the first closes. */
let picking = false;
const onePicker = async <T>(open: () => Promise<T>, none: T): Promise<T> => {
  if (picking) return none;
  picking = true;
  try {
    return await open();
  } finally {
    picking = false;
  }
};

export const nativeMedia: Media = {
  async recent() {
    if (!libraryAvailable()) return { access: 'denied', photos: [] };
    try {
      let permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
      if (!permission.granted && permission.canAskAgain) permission = await MediaLibrary.requestPermissionsAsync(false, ['photo']);
      const access = accessOf(permission);
      if (access === 'denied') return { access, photos: [] };
      const page = await MediaLibrary.getAssetsAsync({
        first: RECENT_PHOTOS,
        mediaType: 'photo',
        sortBy: [['creationTime', false]],
      });
      return { access, photos: page.assets.map((a) => ({ id: a.id, uri: a.uri })) };
    } catch {
      // a library that cannot be read leaves the sheet with Camera and Photos, as a refusal does
      return { access: 'denied', photos: [] };
    }
  },
  async manageLimited() {
    await MediaLibrary.presentPermissionsPickerAsync(['photo']);
  },
  async photos(ids) {
    const out: Picked[] = [];
    for (const id of ids) {
      const info = await MediaLibrary.getAssetInfoAsync(id);
      const source = info.localUri ?? info.uri;
      const long = Math.max(info.width, info.height);
      // re-encoded as JPEG even when small: iOS keeps HEIC, which the Mac's models do not read
      const shot = await manipulateAsync(
        source,
        long > LONG_SIDE ? [{ resize: info.width >= info.height ? { width: LONG_SIDE } : { height: LONG_SIDE } }] : [],
        { format: SaveFormat.JPEG, compress: 0.8, base64: true },
      );
      if (!shot.base64) throw new Error('That photo could not be read.');
      out.push({ name: `${info.filename.replace(/\.[^.]*$/, '') || 'photo'}.jpg`, mime: 'image/jpeg', base64: shot.base64, uri: shot.uri });
    }
    return out;
  },
  async files() {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (result.canceled) return [];
    const out: Picked[] = [];
    for (const a of result.assets) {
      const mime = a.mimeType ?? 'application/octet-stream';
      out.push({ name: a.name, mime, base64: await new File(a.uri).base64(), ...(mime.startsWith('image/') ? { uri: a.uri } : {}) });
    }
    return out;
  },
  // The system photo picker hands over only the photos the person chooses and needs no library permission on either platform.
  library: (room, prep) =>
    onePicker(
      async () => {
        const compressor = videoCompressor();
        const began = Date.now();
        const result = await ImagePicker.launchImageLibraryAsync(libraryOptions(room, compressor));
        const handed = Date.now();
        const assets = result.canceled ? [] : result.assets;
        prep?.handed?.({ videos: assets.filter((a) => a.type === 'video').length });
        const chosen = await readAll(result, compressor, prep);
        // how long the picker took to hand the choice over (its own copy of each original, and the time spent in it), and how long the items then took to be made ready
        if (assets.length)
          perf.pick({
            seconds: Math.round((handed - began) / 100) / 10,
            count: assets.length,
            videos: assets.filter((a) => a.type === 'video').length,
            readSeconds: Math.round((Date.now() - handed) / 100) / 10,
          });
        return chosen;
      },
      { picked: [], refused: [] },
    ),
  camera: () =>
    onePicker(async () => {
      const access = await ImagePicker.requestCameraPermissionsAsync();
      if (!access.granted) throw new AccessDenied('camera', 'Allow camera access in Settings to take a photo.');
      return asPicked(await ImagePicker.launchCameraAsync(picker));
    }, null),
  startRecording: () =>
    inOrder(async () => {
      const access = await AudioModule.requestRecordingPermissionsAsync();
      if (!access.granted) throw new AccessDenied('microphone', 'Allow microphone access in Settings to dictate.');
      const old = recorder;
      recorder = null;
      await old?.stop().catch(() => undefined);
      await recordingMode(true);
      // 16 kHz mono linear PCM in a WAV container is what the Mac's speech engine reads
      const next = new AudioModule.AudioRecorder({
        ...RecordingPresets.HIGH_QUALITY,
        extension: '.wav',
        sampleRate: 16000,
        isMeteringEnabled: true,
        numberOfChannels: 1,
        ios: { ...RecordingPresets.HIGH_QUALITY.ios, extension: '.wav', outputFormat: 'lpcm' as never },
      });
      try {
        await next.prepareToRecordAsync();
        next.record();
        recorder = next;
      } catch (error) {
        await playbackAgain();
        throw error;
      }
    }),
  stopRecording: () =>
    inOrder(async () => {
      const active = recorder;
      recorder = null;
      if (!active) throw new Error('No recording is in progress.');
      try {
        await active.stop();
      } finally {
        await playbackAgain();
      }
      if (!active.uri) throw new Error('The recording could not be saved.');
      return { base64: await new File(active.uri).base64(), mime: 'audio/wav' as const };
    }),
  level() {
    try {
      const db = recorder?.getStatus().metering;
      // the meter reads decibels from silence at about -60 up to 0
      return typeof db === 'number' && Number.isFinite(db) ? Math.min(1, Math.max(0, (db + 60) / 60)) : null;
    } catch {
      // a recorder that cannot say how loud it is only draws a flat meter
      return null;
    }
  },
  cancelRecording: () =>
    inOrder(async () => {
      const active = recorder;
      recorder = null;
      if (!active) return;
      try {
        await active.stop();
      } finally {
        await playbackAgain();
      }
    }),
};
