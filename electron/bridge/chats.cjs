// window.native.chats: the chat store and the data migration (electron/app/ipc/chats.cjs).
const { invoke, on } = require('./spec.cjs');

module.exports = {
  snapshot: invoke('chats:snapshot'),
  delete: invoke('chats:delete', 1),
  deletions: invoke('chats:deletions'),
  onDeleted: on('chats:deleted'),
  patchMeta: invoke('chats:patchMeta', 2),
  setSegments: invoke('chats:setSegments', 2),
  onChanged: on('chats:changed'),
  onReset: on('chats:reset'),
  migration: invoke('migration:status'),
  retryMigration: invoke('migration:retry'),
  migrationReport: invoke('migration:report'),
  restoreMigration: invoke('migration:restore'),
};
