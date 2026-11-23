// "Get the app" in Connect your phone: a second QR that holds only where to download the phone app, never a pairing secret. Nothing shows while there is no link.
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { ignoring } from '../../../lib/ignored';
import { PHONE_APP_URL } from '../../../lib/phoneApp';

export function GetTheApp({ url = PHONE_APP_URL }: { url?: string }) {
  const [open, setOpen] = useState(false);
  const [image, setImage] = useState('');
  useEffect(() => {
    let live = true;
    if (open && url)
      void QRCode.toDataURL(url, { margin: 2, width: 200 }).then((next) => live && setImage(next), ignoring('draw the Get the app QR'));
    return () => {
      live = false;
    };
  }, [open, url]);
  if (!url) return null;
  if (!open)
    return (
      <button type="button" className="link-btn" onClick={() => setOpen(true)}>
        Don't have the app?
      </button>
    );
  return (
    <div className="mobile-remote-qr">
      {image && <img src={image} width={140} height={140} alt="QR code to get the app" />}
      <div className="settings-row-desc">Scan with your phone's camera to get MoPilot</div>
    </div>
  );
}
