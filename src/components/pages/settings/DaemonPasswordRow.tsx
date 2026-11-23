// The Add machine card's question for a Mac nobody is signed in on: its administrator password in a secure field, in the same row as ssh's own questions (HostConnectPrompt), to add the machine again with its Host started before anyone signs in (electron/host/install.cjs, Keep running after restart). The password goes to the machine's sudo only; nothing here keeps it.
import { useState } from 'react';
import { Row } from './Controls';
import { isEnter } from '../../../lib/focus';

export function DaemonPasswordRow({
  target,
  onCancel,
  onSubmit,
}: {
  target: string;
  onCancel: () => void;
  onSubmit: (password: string) => void;
}) {
  const [value, setValue] = useState('');
  const send = () => {
    if (!value) return;
    const password = value;
    setValue('');
    onSubmit(password);
  };
  return (
    <Row title={`Administrator password for ${target}`} desc="Starts it before anyone signs in. MoPilot doesn’t keep it.">
      <input
        className="text-input slim wide"
        type="password"
        autoComplete="off"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => isEnter(e) && send()}
        aria-label={`Administrator password for ${target}`}
      />
      <button className="btn-pill soft" onClick={onCancel}>
        Cancel
      </button>
      <button className="btn-pill primary" disabled={!value} onClick={send}>
        Turn on
      </button>
    </Row>
  );
}
