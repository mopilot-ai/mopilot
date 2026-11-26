// Add on Control this Mac with pairing by code on (R2b of #5576, behind host.codePair): one dialog for the two kinds of device that may control this Mac, a Phone (its QR dialog, as before) or a Computer (this Mac's own code, ComputerCodePane).
import { useState } from 'react';
import { Modal } from '../../ui/Modal';
import { ComputerCodePane } from './ComputerCodePane';

export function AddDeviceDialog({ onPhone, onClose }: { onPhone: () => void; onClose: () => void }) {
  const [kind, setKind] = useState<'phone' | 'computer'>('phone');
  return (
    <Modal title="Add a device" onClose={onClose}>
      <div className="conn-tabs" role="tablist" aria-label="Kind of device">
        {(['phone', 'computer'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            className={`ps-tab ${kind === k ? 'on' : ''}`}
            onClick={() => setKind(k)}
          >
            {k === 'phone' ? 'Phone' : 'Computer'}
          </button>
        ))}
      </div>
      {kind === 'phone' ? (
        <div className="machine-sheet">
          <p className="machine-sheet-lede">Scan a code with the MoPilot app on your phone.</p>
          <div className="machine-sheet-actions">
            <button
              type="button"
              className="btn-pill primary"
              onClick={() => {
                onClose();
                onPhone();
              }}
            >
              Show the code
            </button>
          </div>
        </div>
      ) : (
        <ComputerCodePane />
      )}
    </Modal>
  );
}
