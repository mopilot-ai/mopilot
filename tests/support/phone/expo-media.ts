// Controllable stand-ins for expo-image-picker, expo-media-library, expo-image-manipulator, expo-document-picker, expo-audio and expo-file-system in the phone media adapter tests.
const state = () => (globalThis as any).__phoneMedia as Record<string, any>;
export const requestMediaLibraryPermissionsAsync = async () => {
  state().libraryPermissionAsked = true;
  return { granted: state().library !== 'denied' };
};
/** The photo library: `state().access` is 'all' | 'limited' | 'none' | 'undetermined' (asking turns it into `askResult`). */
export const getPermissionsAsync = async (writeOnly: boolean, granular: string[]) => {
  state().libraryAsked = { writeOnly, granular };
  const access = state().access ?? 'all';
  return { granted: access === 'all' || access === 'limited', canAskAgain: access === 'undetermined', accessPrivileges: access };
};
export const requestPermissionsAsync = async () => {
  state().libraryPrompted = true;
  const access = state().askResult ?? 'none';
  return { granted: access === 'all' || access === 'limited', canAskAgain: false, accessPrivileges: access };
};
export const getAssetsAsync = async (options: unknown) => {
  state().assetsOptions = options;
  if (state().assetsFail) throw new Error('library unavailable');
  return { assets: state().assets ?? [] };
};
export const getAssetInfoAsync = async (id: string) => {
  const info = state().infos?.[id];
  if (!info) throw new Error('missing asset');
  return info;
};
export const presentPermissionsPickerAsync = async (types: unknown) => {
  state().manageOpened = types;
  state().access = state().afterManage ?? state().access;
};
export const SaveFormat = { JPEG: 'jpeg' };
export const manipulateAsync = async (uri: string, actions: unknown[], options: unknown) => {
  (state().manipulated ??= []).push({ uri, actions, options });
  return state().manipulateResult ?? { uri: `${uri}.jpg`, base64: 'SlBFRw==' };
};
export const getDocumentAsync = async (options: unknown) => (
  (state().documentOptions = options), state().documentResult ?? { canceled: true, assets: null }
);
export const requestCameraPermissionsAsync = async () => ({ granted: state().camera !== 'denied' });
/** A picker that stays on screen until the test sets `release`, and counts how many times one was presented. */
const present = async (kind: 'library' | 'camera', options: unknown) => {
  const s = state();
  s.options = options;
  s.presented = [...(s.presented ?? []), kind];
  if (s.hold) await new Promise<void>((resolve) => (s.release = resolve));
  return s[`${kind}Result`];
};
export const launchImageLibraryAsync = (options: unknown) => present('library', options);
/** The export presets the real module names; only the numbers the adapter picks matter here. */
export const VideoExportPreset = { Passthrough: 0, MediumQuality: 2, H264_1280x720: 6 };
export const UIImagePickerPreferredAssetRepresentationMode = { Automatic: 'automatic', Compatible: 'compatible', Current: 'current' };
export const launchCameraAsync = (options: unknown) => present('camera', options);
export const RecordingPresets = { HIGH_QUALITY: { extension: '.m4a', ios: { extension: '.m4a' } } };
/** The session modes the adapter set, in order: iOS refuses to record until recording is allowed (expo-audio setAudioModeAsync). */
export const setAudioModeAsync = async (mode: unknown) => {
  (state().modes ??= []).push(mode);
  if (state().modeFails) throw new Error('audio session unavailable');
  // leaving recording mode stops a recorder that is running, as the native session does
  if (!(mode as any).allowsRecording && state().recording) {
    state().recording = false;
    state().modeStoppedRecording = (state().modeStoppedRecording ?? 0) + 1;
  }
};
const recordingAllowed = () => {
  const modes = state().modes ?? [];
  return !!(modes.length && (modes[modes.length - 1] as any).allowsRecording);
};
export const AudioModule = {
  requestRecordingPermissionsAsync: async () => ({ granted: state().mic !== 'denied' }),
  AudioRecorder: class {
    uri: string | null = state().uri ?? null;
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
      state().recorder = this;
    }
    prepareToRecordAsync = async () => {
      if (state().slowPrepare) await new Promise((resolve) => setTimeout(resolve, 20));
      (state().prepared ??= []).push(this);
      if (state().prepareFails) throw new Error('microphone busy');
      // the native recorder refuses to prepare unless the last mode set allows recording
      if (!recordingAllowed()) throw new Error('Recording not allowed on iOS. Enable with Audio.setAudioModeAsync');
      this.ready = true;
    };
    ready = false;
    getStatus = () => {
      if (state().meteringFails) throw new Error('no status');
      return { metering: state().metering };
    };
    record = () => {
      // the native record() checks the microphone permission, then that recording is allowed; one never prepared does nothing
      if (state().mic === 'denied') throw new Error('Missing microphone permission');
      if (!recordingAllowed()) throw new Error('Recording not allowed on iOS. Enable with Audio.setAudioModeAsync');
      if (!this.ready) return;
      state().recording = true;
    };
    stop = async () => {
      // a stopped recorder is done: record() on it does nothing until a new prepare
      this.ready = false;
      state().recording = false;
      state().stops = (state().stops ?? 0) + 1;
      if (state().stopFails) throw new Error('already stopped');
      if (state().stopThrowsOnce) {
        state().stopThrowsOnce = false;
        throw new Error('stop failed');
      }
    };
  },
};
export class File {
  uri: string;
  constructor(uri: string) {
    if (state().unopenable?.includes(uri)) throw new Error('native: cannot open that file');
    this.uri = uri;
  }
  /** The file's size when the picker did not give one: `sizes[uri]`, or null for a file that is not there. */
  get size() {
    if (state().sizeThrows) throw new Error('native: no size');
    return state().sizes?.[this.uri] ?? null;
  }
  /** Deletes the file: recorded, so a test reads which temporary files were cleared. */
  delete = () => {
    (state().deleted ??= []).push(this.uri);
    if (state().deleteThrows) throw new Error('already gone');
  };
  base64 = async () => {
    (state().reads ??= []).push(this.uri);
    if (state().unreadable?.includes(this.uri)) throw new Error('file gone');
    return `bytes-of:${this.uri}`;
  };
}
let seed = 0;
/** Distinct bytes per call, so ids made in one test never collide. */
export const getRandomBytes = (length: number) => new Uint8Array(length).fill(++seed % 256);
