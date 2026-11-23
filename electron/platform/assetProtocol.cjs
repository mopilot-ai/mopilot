// Local image and audio/video responses preserve byte ranges and use the shared preview MIME allowlist.
const { pathToFileURL } = require('node:url');
const { previewMediaType } = require('../../shared/filePreview.mjs');

function createAssetHandler(net, isWin) {
  return async (request) => {
    let path;
    try {
      path = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response('Invalid file URL', { status: 400 });
    }
    if (isWin && /^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    const mime = previewMediaType(path);
    if (!mime) return new Response('File type is not served', { status: 403 });
    try {
      const response = await net.fetch(pathToFileURL(path).toString(), { headers: request.headers });
      const headers = new Headers(response.headers);
      headers.set('Content-Type', mime);
      headers.set('Cache-Control', 'no-store');
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response('File is unavailable', { status: 404 });
    }
  };
}

module.exports = { createAssetHandler };
