// Controllable camera permission and scan boundary for mobile component tests, as expo-camera behaves: a permission answer says whether it is granted, only the barcode types asked for are read, the code is reported in every frame while it is in view, and a camera can fail to start (`__phoneCameraMount = 'error'`).
import { useEffect } from 'react';

const g = () => globalThis as any;
export const CameraView = (props: any) => {
  g().__phoneCameraProps = props;
  const failing = g().__phoneCameraMount === 'error';
  useEffect(() => {
    if (failing) props.onMountError?.({ message: 'Camera not available' });
  }, [failing]);
  if (failing) return null;
  return (
    <button
      onClick={() => {
        if (!props.barcodeScannerSettings?.barcodeTypes?.includes('qr')) return;
        const frame = { type: 'qr', data: 'scanned code' };
        props.onBarcodeScanned?.(frame);
        props.onBarcodeScanned?.(frame);
      }}
    >
      Camera preview
    </button>
  );
};
export const useCameraPermissions = () => [
  null,
  async () => {
    const answer = await g().__phoneCamera();
    if (typeof answer?.granted !== 'boolean') throw new Error('A camera permission answer says whether it is granted.');
    return answer;
  },
];
