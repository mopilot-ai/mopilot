// window.native.fs: the local file helpers windows use (electron/platform/fs.cjs, electron/app/ipc/files.cjs).
const { invoke, filePath } = require('./spec.cjs');

module.exports = {
  exists: invoke('fs:exists', 1),
  messagePath: invoke('fs:messagePath', 2),
  mkdirProjectless: invoke('fs:mkdirProjectless', 3),
  readText: invoke('fs:readText', 1),
  readPreview: invoke('fs:readPreview', 1),
  writeText: invoke('fs:writeText', 2),
  configRoots: invoke('fs:configRoots'),
  readDir: invoke('fs:readDir', 1),
  remove: invoke('fs:remove', 1),
  readImageDataUrl: invoke('fs:readImageDataUrl', 1),
  saveTempImage: invoke('fs:saveTempImage', 1),
  pathForFile: filePath(),
};
