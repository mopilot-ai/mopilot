// Test-only microphone boundary for the web preview: permission is refused, so nothing records.
export const AudioModule = {
  requestRecordingPermissionsAsync: async () => ({ granted: false }),
  AudioRecorder: class {},
};
export const RecordingPresets = { HIGH_QUALITY: {} };
export const setAudioModeAsync = async () => undefined;
