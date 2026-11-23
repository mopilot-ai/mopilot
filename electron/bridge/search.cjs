// window.native.search: file and text search in a folder (electron/platform/search.cjs, searchText.cjs).
const { invoke } = require('./spec.cjs');

module.exports = {
  files: invoke('platform:search:files', 3),
  text: invoke('platform:search:text', 3),
};
