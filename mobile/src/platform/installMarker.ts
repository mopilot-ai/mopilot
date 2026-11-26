// A mark in the app's cache folder, which is not backed up and goes with an uninstall: absent, the thing it marks has not happened since the app was installed (or the system emptied the cache), whatever a backup restored or the Keychain kept.
import { File, Paths } from 'expo-file-system';

export function markerFor(name: string) {
  const file = () => new File(Paths.cache, name);
  return {
    present: async () => file().exists,
    set: async () => file().create({ overwrite: true, intermediates: true }),
    clear: async () => {
      const found = file();
      if (found.exists) found.delete();
    },
  };
}
