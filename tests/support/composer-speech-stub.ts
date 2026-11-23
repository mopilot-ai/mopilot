// Composer tests exercise speech choices and audio handoff through an imperative recorder boundary.
import { createElement, useEffect, useImperativeHandle } from 'react';
export function dictationStub(stopped: () => void) {
  return function Dictation({ onText, onAudio, control }: any) {
    useEffect(() => stopped, []);
    useImperativeHandle(control, () => ({
      dictate: () => onText('spoken words'),
      audio: () => onAudio({ kind: 'audio', path: '/saved.wav', name: 'Audio message' }),
    }));
    return createElement('button', { className: 'stub-dictate', onClick: () => onText('spoken words') }, 'dictate');
  };
}
