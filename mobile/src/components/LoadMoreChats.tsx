// The button under the recent-chats list that reads the next page; it says so while the page is on its way.
import { Button } from './ui';

export function LoadMoreChats({ loading, disabled, onPress }: { loading: boolean; disabled: boolean; onPress: () => void }) {
  return <Button secondary title={loading ? 'Loading…' : 'Load more chats'} disabled={loading || disabled} onPress={onPress} />;
}
