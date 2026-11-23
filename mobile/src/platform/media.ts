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

export type Voice = { base64: string; mime: 'audio/wav' };
/** What the app may read of the photo library: all of it, only the photos the person shared with the app, or none. */
export type LibraryAccess = 'full' | 'limited' | 'denied';
export type RecentPhoto = { id: string; uri: string };
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
  /** Null when the person cancels the picker; the system picker needs no permission. */
  library(): Promise<Picked | null>;
  camera(): Promise<Picked | null>;
  startRecording(): Promise<void>;
  /** Stops and returns the clip the Mac's engine reads. */
  stopRecording(): Promise<Voice>;
  cancelRecording(): Promise<void>;
  /** How loud the recording is right now, 0 to 1; null when nothing is recording or the device does not say. Only drawn, never kept or sent. */
  level(): number | null;
}

const asPicked = (result: ImagePicker.ImagePickerResult): Picked | null => {
  const asset = result.canceled ? null : result.assets[0];
  if (!asset) return null;
  if (!asset.base64) throw new Error('That photo could not be read.');
  return { name: asset.fileName ?? 'photo.jpg', mime: asset.mimeType ?? 'image/jpeg', base64: asset.base64, uri: asset.uri };
};
const picker = { base64: true, quality: 0.8, mediaTypes: ['images' as const] };

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
const onePicker = async (open: () => Promise<Picked | null>): Promise<Picked | null> => {
  if (picking) return null;
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
  library: () => onePicker(async () => asPicked(await ImagePicker.launchImageLibraryAsync(picker))),
  camera: () =>
    onePicker(async () => {
      const access = await ImagePicker.requestCameraPermissionsAsync();
      if (!access.granted) throw new AccessDenied('camera', 'Allow camera access in Settings to take a photo.');
      return asPicked(await ImagePicker.launchCameraAsync(picker));
    }),
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
