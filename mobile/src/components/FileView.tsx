// A text file of the chat's folder, a page at a time from the Mac.
import { Text } from 'react-native';
import type { Capabilities, Owned } from '../remote/client';
import { usePaged } from '../remote/usePaged';
import { readFile, type FilePage } from '../remote/review';
import { Button, Card, ErrorLine, useStyles } from './ui';
import { Loadable } from './Loadable';

function Pages({ first, more }: { first: FilePage; more: (offset: number) => Promise<FilePage> }) {
  const styles = useStyles();
  const paged = usePaged<string>(
    { items: first.text, next: first.next },
    async (offset) => {
      const page = await more(offset);
      return { items: page.text, next: page.next };
    },
    (all, page) => all + page,
  );
  const { items: text, next, error, busy } = paged;
  if (!text && next === null) return <Text style={styles.muted}>This file is empty.</Text>;
  return (
    <>
      <Card>
        <Text selectable style={styles.text}>
          {text}
        </Text>
      </Card>
      <ErrorLine text={error} />
      {next !== null && (
        <Button
          secondary
          title={busy ? 'Loading…' : error ? 'Retry' : `Load more (${Math.ceil(next / 1024)} of ${Math.ceil(first.size / 1024)} KB)`}
          disabled={busy}
          onPress={() => {
            void paged.load();
          }}
        />
      )}
      {error && (
        <Button
          secondary
          title="Start over"
          disabled={busy}
          onPress={() => {
            void paged.reload();
          }}
        />
      )}
    </>
  );
}

export function FileView({
  request,
  chatId,
  path,
  caps,
}: {
  request: Owned;
  chatId: string;
  path: string;
  caps: Promise<Capabilities | null>;
}) {
  const page = async (offset: number) => readFile(request, chatId, path, offset, await caps);
  return (
    <Loadable what="file" load={() => page(0)}>
      {(first) => <Pages first={first} more={page} />}
    </Loadable>
  );
}
