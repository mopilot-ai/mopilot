// window.native.menu's types (native context menus), merged into NativeApi; the calls are declared in electron/bridge/menu.cjs.
import type { NativeMenuItem } from '../native';

declare module '../native' {
  interface NativeApi {
    menu: {
      popup(items: NativeMenuItem[]): Promise<string | null>;
      /** The picture's right-click menu: Copy Image, Save Image As…, and Show in Finder when `path` is its file. */
      image(image: { src?: string; path?: string }): Promise<void>;
    };
  }
}
