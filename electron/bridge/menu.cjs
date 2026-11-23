// window.native.menu: native context menus (electron/app/ipc/window.cjs).
const { invoke } = require('./spec.cjs');

module.exports = {
  popup: invoke('menu:popup', 1),
  image: invoke('menu:image', 1),
};
