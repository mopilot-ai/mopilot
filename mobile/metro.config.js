// Resolve the shared remote protocol from the repository alongside the Expo application, and the phone's private
// modules in place of their shared stand-ins where the checkout has them (mobile/config/privateModules.js).
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const { resolvePrivate } = require('./config/privateModules');
const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '..')];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
config.resolver.resolveRequest = resolvePrivate(config.resolver.resolveRequest);
module.exports = config;
