// A message of yours as plain words with its web and mail addresses as links, so a tap or a long press on one does what it does in a reply.
import { Fragment, useMemo } from 'react';
import { bareLinks } from '../../../shared/markdownParse.mjs';
import { LinkText } from './Markdown';

/** `text` as it was written, each address in it a link; to be drawn inside a Text. */
export function LinkedText({ text, color }: { text: string; color: string }) {
  const parts = useMemo(() => {
    const out: { at: number; text: string; url?: string }[] = [];
    let at = 0;
    for (const { start, end, url } of bareLinks(text)) {
      if (start > at) out.push({ at, text: text.slice(at, start) });
      out.push({ at: start, text: text.slice(start, end), url });
      at = end;
    }
    if (at < text.length) out.push({ at, text: text.slice(at) });
    return out;
  }, [text]);
  return (
    <>
      {parts.map((part) =>
        part.url ? (
          <LinkText key={part.at} url={part.url} color={color}>
            {part.text}
          </LinkText>
        ) : (
          <Fragment key={part.at}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}
