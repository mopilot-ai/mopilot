// What scripts/package.mjs adds for Auto routing: the verified OpenSquilla weights and this build's ONNX Runtime binary.
import path from 'node:path';
import { fetchAssets } from '../fetch-auto-route-assets.mjs';

/**
 * Fetches the weights into build/vendor/auto-route (shipped as Resources/auto-route, where
 * electron/autoRoute/squilla/assets.cjs looks first) and says what of onnxruntime-node to keep and unpack.
 * onnxruntime-node carries every platform's binaries (about 300 MB); the app keeps only its own platform and arch, and on
 * macOS drops the versioned copy of the dylib (the binding loads libonnxruntime.1.dylib). It has no macOS x64 build:
 * that package keeps none and the router reports itself unavailable there.
 * @param {{ platform: string, arch: string, fetch?: (o: { out: string }) => Promise<unknown> }} o
 */
export async function autoRoutePackaging({ platform, arch, fetch = fetchAssets }) {
  const resource = path.resolve('build', 'vendor', 'auto-route');
  await fetch({ out: path.join(resource, 'squilla') });
  return {
    resource,
    ignore: [
      new RegExp(`^/node_modules/onnxruntime-node/bin/napi-v\\d+/(?!${platform}/${arch}(/|$))`),
      /^\/node_modules\/onnxruntime-node\/bin\/napi-v\d+\/darwin\/[^/]+\/libonnxruntime\.\d+\.\d+\.\d+\.dylib$/,
    ],
    // native code cannot load from inside app.asar
    unpack: '**/node_modules/onnxruntime-node/bin/**',
  };
}
