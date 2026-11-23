// What a link in a message may do: only web and mail addresses are opened (never a scheme a model wrote), and a long press offers Open and Copy link in the action sheet iOS draws for a link.
import { ActionSheetIOS, Linking } from 'react-native';
import { chatIdOfLink } from '../chatLinks';
import { copyText } from '../platform/clipboard';

/** Whether iOS is asked to open `url`: a web or mail address. Any other scheme (tel:, sms:, a custom app's) is shown and can be copied, but never opened from a message. */
export const openable = (url: string) => /^(https?|mailto):/i.test(url);

/** The words of the menu, in the language shown. */
export type LinkMenuWords = { open: string; copy: string; cancel: string };

/** Asks what to do with `url`; `open` is what a tap does, or null for a link that is not opened (the menu then offers Copy link alone). An email address is copied as the address, without `mailto:`. */
export function showLinkMenu(url: string, words: LinkMenuWords, open: (() => void) | null) {
  const actions = [
    ...(open ? [{ label: words.open, run: open }] : []),
    { label: words.copy, run: () => void copyText(url.replace(/^mailto:/i, '')) },
  ];
  ActionSheetIOS.showActionSheetWithOptions(
    { title: url, options: [...actions.map((a) => a.label), words.cancel], cancelButtonIndex: actions.length },
    (index) => actions[index]?.run(),
  );
}

/** What a tap on `url` does: a MoPilot chat opens in the app, a web or mail address goes to iOS; null for any other link, which is only shown and copied. */
export function linkOpener(url: string, openChat: ((chatId: string) => void) | undefined): (() => void) | null {
  const chatId = chatIdOfLink(url);
  if (chatId) return () => openChat?.(chatId);
  return openable(url) ? () => void Linking.openURL(url).catch(() => undefined) : null;
}
