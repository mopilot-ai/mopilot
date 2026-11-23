// Test-only camera boundary for the isolated web preview.
import React from 'react';
export const CameraView = () => <div>Camera preview</div>;
export const useCameraPermissions = () => [
  null,
  async () => {
    (window as any).cameraRequests++;
    return { granted: (window as any).cameraGranted };
  },
];
