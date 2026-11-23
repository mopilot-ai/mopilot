// Settings → Voice: dictation engine, microphone, voice and hotkey, and saved recordings.

import { Group, Row, Select } from './Controls';
import { isMac } from '../../../lib/platform';
import { ChevronDown, ChevronRight } from '../../ui/icons';
import { useEffect, useRef, useState } from 'react';
import { useStore, setPrefs, toast, toastFailure } from '../../../store/core';
import { native } from '../../../lib/native';
import { errorText, noteIgnored } from '../../../lib/ignored';
import { noSpeechReason, type SpeechOptions } from '../../../../shared/speech.mjs';
import { DICTATION_ENGINES, type DictationEngine } from '../../../lib/dictation';
import { useEffectOn } from '../../../lib/effects';
import { HotkeyField } from './Rows';

/* ------------------------------------------------------------------ */
/* Voice                                                               */
/* ------------------------------------------------------------------ */
const V3_VOICES = ['cove', 'juniper', 'maple', 'spruce', 'ember', 'vale', 'breeze', 'arbor', 'sol'];
export function VoiceSettings() {
  const prefs = useStore((s) => s.prefs);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [services, setServices] = useState<SpeechOptions | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);
  useEffectOn([prefs.dictationLanguage, prefs.dictationEngine], () => {
    let current = true;
    void native.speech.options().then(
      (v) => {
        if (current) {
          setServices(v);
          setServiceError(null);
        }
      },
      (e) => {
        if (current) setServiceError(errorText(e));
      },
    );
    return () => {
      current = false;
    };
  });
  const engine = prefs.dictationEngine ?? 'auto';
  const selected = services?.choices.find((p) => p.id === engine);
  const automatic = !services
    ? 'Checking services…'
    : services.chain.length
      ? `Uses ${services.chain.map((id) => DICTATION_ENGINES.find((e) => e.value === id)?.label ?? id).join(', then ')}. A chat whose harness has its own speech service uses that first; a clip moves on when one can't transcribe it.`
      : noSpeechReason(null, services.choices);
  useEffect(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((d) => setMics(d.filter((x) => x.kind === 'audioinput' && x.deviceId !== 'default' && x.label)))
      // no device list: the default microphone still works
      .catch((e) => noteIgnored('list the microphones', e));
  }, []);
  return (
    <>
      <Group title="General">
        <Row title="Microphone" desc="Used for voice chat and dictation">
          <Select
            value={prefs.micDeviceId ?? 'default'}
            options={[{ value: 'default', label: 'System default' }, ...mics.map((m) => ({ value: m.deviceId, label: m.label }))]}
            onChange={(v) => setPrefs({ micDeviceId: v === 'default' ? null : v })}
          />
        </Row>
        <Row
          title="Dictation engine"
          desc={
            serviceError ?? (engine === 'auto' ? automatic : (selected?.reason ?? DICTATION_ENGINES.find((e) => e.value === engine)?.desc))
          }
        >
          <Select
            value={engine}
            options={[
              { value: 'auto', label: 'Automatic' },
              ...DICTATION_ENGINES.filter((e) => e.value !== 'local' || isMac).map((e) => ({ value: e.value, label: e.label })),
            ]}
            onChange={async (v) => {
              setPrefs({ dictationEngine: v === 'auto' ? null : (v as DictationEngine) });
              if (v !== 'local') return;
              // the first use asks macOS for Speech Recognition (the helper holds it); say if it can't work
              let st: Awaited<ReturnType<typeof native.dictation.localRequest>>;
              try {
                st = await native.dictation.localRequest(prefs.dictationLanguage);
              } catch (e) {
                return toastFailure("Couldn't start the on-device recognizer")(e);
              }
              if (!st) toast("Couldn't start the on-device recognizer", 'error');
              else if ('failure' in st) toast(st.failure, 'error');
              else if (st.authorization !== 'authorized')
                toast('Allow Speech Recognition for "MoPilot" in System Settings → Privacy & Security', 'error');
              else if (!st.available || !st.onDevice) toast(`On-device recognition isn't available for ${st.locale}`, 'error');
            }}
          />
        </Row>
        <Row title="Language" desc="Automatic uses the macOS system locale on this Mac; cloud services may detect the language.">
          <Select
            value={prefs.dictationLanguage}
            options={[
              { value: 'auto', label: 'Automatic' },
              { value: 'en', label: 'English' },
              { value: 'zh', label: 'Chinese' },
              { value: 'es', label: 'Spanish' },
              { value: 'fr', label: 'French' },
              { value: 'de', label: 'German' },
              { value: 'ja', label: 'Japanese' },
              { value: 'ko', label: 'Korean' },
            ]}
            onChange={(v) => setPrefs({ dictationLanguage: v })}
          />
        </Row>
      </Group>
      <Group title="Native voice conversation">
        <Row title="Voice" desc="Voice for this chat’s native realtime provider" applies="codex">
          <Select
            value={V3_VOICES.includes(prefs.voice) ? prefs.voice : 'cove'}
            options={V3_VOICES.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))}
            onChange={(v) => setPrefs({ voice: v })}
          />
        </Row>
        <Row title="Voice input hotkey" desc="Dictate into the focused chat from anywhere on desktop">
          <HotkeyField
            value={prefs.voiceHotkey}
            onChange={async (acc) => {
              // the setting changes only once main has (un)registered the shortcut
              try {
                const taken = !(await native.voice.setHotkey(acc));
                if (acc && taken) return toast('That shortcut is already in use', 'error');
              } catch (e) {
                return toastFailure("Couldn't change the voice chat hotkey")(e);
              }
              setPrefs({ voiceHotkey: acc });
            }}
          />
        </Row>
      </Group>
      <Group title="Dictation">
        <Recordings />
      </Group>
    </>
  );
}

/** Last 20 dictation recordings, saved on this device. */
function Recordings() {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<{ id: string; text: string; at: number }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const readVersion = useRef(0);
  useEffect(() => {
    if (!open) return;
    const version = ++readVersion.current;
    const ownsRead = () => version === readVersion.current;
    setError(null);
    // a list that couldn't be read says why, not that there are no recordings
    native.recordings.list().then(
      (records) => {
        if (ownsRead()) setList(records);
      },
      (e) => {
        if (ownsRead()) setError(errorText(e));
      },
    );
    return () => {
      ++readVersion.current;
    };
  }, [open]);
  return (
    <>
      <Row title="Recent recordings" desc="Your last 20 recordings are saved on this device" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </Row>
      {open && error && <div className="settings-pad tight center-text settings-row-desc">Couldn't read the recordings: {error}</div>}
      {open &&
        !error &&
        (list?.length ? (
          <>
            {list.map((r) => (
              <Row
                key={r.id}
                title={new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                desc={r.text}
              >
                <button
                  className="btn-pill soft"
                  onClick={async () => {
                    try {
                      const url = await native.recordings.read(r.id);
                      if (url) await new Audio(url).play();
                    } catch (e) {
                      toastFailure("Couldn't play the recording")(e);
                    }
                  }}
                >
                  Play
                </button>
              </Row>
            ))}
            <Row title="Delete all recordings">
              <button
                className="btn-pill danger"
                onClick={async () => {
                  const version = readVersion.current;
                  try {
                    await native.recordings.clear();
                    if (version !== readVersion.current) return;
                    // A snapshot requested before deletion cannot restore the deleted clips or its old error.
                    ++readVersion.current;
                    setError(null);
                    setList([]);
                  } catch (e) {
                    toastFailure("Couldn't delete the recordings")(e);
                  }
                }}
              >
                Delete
              </button>
            </Row>
          </>
        ) : (
          <div className="settings-pad tight center-text settings-row-desc">No recordings yet</div>
        ))}
    </>
  );
}
